import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import { cors } from "hono/cors";
// @ts-ignore
import manifest from "__STATIC_CONTENT_MANIFEST";

// ─── Constants ───

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_PINS_PER_USER = 5;
const APP_VERSION = "0.5.0";

// ─── Types ───

type Bindings = {
  DB: D1Database;
  BOT_TOKEN: string;
  GROUP_CHAT_ID: string;
  GDRIVE_SERVICE_ACCOUNT_KEY: string;
  GDRIVE_ROOT_FOLDER_ID: string;
  STALE_THRESHOLD_DAYS: string;
  MINI_APP_URL: string;
  GEMINI_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", cors());

// Cache buster: HTML files are never cached
app.use("*", async (c, next) => {
  await next();
  const path = c.req.path;
  if (path.endsWith(".html") || path === "/") {
    c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
  }
});

// ─── Whitelist: authorized Telegram user IDs ───

const ALLOWED_USERS: Record<string, string> = {
  "38070088": "이준민",
  "63576124": "김태근",
  "52860459": "김태윤",
  "87243438": "김완섭",
  "6612424960": "강영구",
};

// ─── Telegram initData HMAC-SHA256 validation ───

async function validateInitData(
  initData: string,
  botToken: string
): Promise<Record<string, any> | null> {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    params.delete("hash");
    const entries = Array.from(params.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secret = await crypto.subtle.sign(
      "HMAC",
      secretKey,
      encoder.encode(botToken)
    );
    const signingKey = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      signingKey,
      encoder.encode(dataCheckString)
    );
    const hexHash = Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (hexHash !== hash) return null;

    const user = params.get("user");
    if (!user) return null;
    return JSON.parse(user);
  } catch {
    return null;
  }
}

// ─── Auth middleware ───

async function authMiddleware(c: any, next: any) {
  const initData = c.req.header("X-Telegram-Init-Data");

  if (!initData) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const user = await validateInitData(initData, c.env.BOT_TOKEN);
  if (!user) return c.json({ error: "Invalid signature" }, 401);

  const userId = String(user.id);
  if (!ALLOWED_USERS[userId]) {
    return c.json({ error: "Access denied" }, 403);
  }

  c.set("user", user);
  await next();
}

// ─── Google Drive helpers ───

async function getGDriveAccessToken(
  serviceAccountKey: string
): Promise<string> {
  const sa = JSON.parse(serviceAccountKey);
  const now = Math.floor(Date.now() / 1000);

  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = btoa(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );

  const signInput = `${header}.${payload}`;

  const pemContents = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryKey = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signInput)
  );

  const jwt = `${signInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  const tokenData = await tokenRes.json<any>();
  if (!tokenData.access_token) {
    throw new Error(`GDrive auth failed: ${JSON.stringify(tokenData)}`);
  }
  return tokenData.access_token;
}

async function createGDriveFolder(
  accessToken: string,
  name: string,
  parentId: string
): Promise<string> {
  const res = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    }
  );
  const data = await res.json<any>();
  return data.id;
}

async function uploadToGDrive(
  accessToken: string,
  file: File,
  folderId: string,
  fileName: string
): Promise<{ id: string; url: string }> {
  const metadata = JSON.stringify({ name: fileName, parents: [folderId] });
  const boundary = "---boundary" + Date.now();

  const fileBytes = await file.arrayBuffer();
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
    ),
    encoder.encode(
      `--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`
    ),
    new Uint8Array(fileBytes),
    encoder.encode(`\r\n--${boundary}--`),
  ];

  const totalLength = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: merged,
    }
  );

  const data = await res.json<any>();
  return {
    id: data.id,
    url:
      data.webViewLink ||
      `https://drive.google.com/file/d/${data.id}/view`,
  };
}

async function deleteFromGDrive(
  accessToken: string,
  fileId: string
): Promise<void> {
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } }
  );
}

// ─── Bot helpers ───

async function sendBotMessage(
  botToken: string,
  chatId: string | number,
  text: string,
  extra: Record<string, any> = {}
) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
}

async function notifyGroup(
  env: Bindings,
  text: string,
  miniAppPath?: string
) {
  const extra: any = { parse_mode: "HTML" };
  if (miniAppPath && env.MINI_APP_URL) {
    extra.reply_markup = {
      inline_keyboard: [
        [
          {
            text: "📋 미니앱에서 보기",
            web_app: { url: `${env.MINI_APP_URL}${miniAppPath}` },
          },
        ],
      ],
    };
  }
  await sendBotMessage(env.BOT_TOKEN, env.GROUP_CHAT_ID, text, extra);
}

// ─── Shared: stale portfolio query ───

async function getStalePortfolios(db: D1Database, threshold: number) {
  const { results } = await db
    .prepare(
      `SELECT name,
        CAST(julianday('now') - julianday(COALESCE(last_update_at, created_at)) AS INTEGER) as days_since
      FROM portfolios
      WHERE status NOT IN ('archived', 'dead')
        AND julianday('now') - julianday(COALESCE(last_update_at, created_at)) > ?
      ORDER BY days_since DESC`
    )
    .bind(threshold)
    .all();
  return results;
}

// ─── Portfolio API ───

app.get("/api/portfolios", authMiddleware, async (c) => {
  const status = c.req.query("status");
  const user = c.get("user") as any;
  const userId = String(user.id);
  const threshold = parseInt(c.env.STALE_THRESHOLD_DAYS || "60");

  let query = `
    SELECT p.*,
      (SELECT COUNT(*) FROM portfolio_updates WHERE portfolio_id = p.id) as update_count,
      (SELECT title FROM portfolio_updates WHERE portfolio_id = p.id ORDER BY update_date DESC LIMIT 1) as latest_update_title,
      (SELECT update_date FROM portfolio_updates WHERE portfolio_id = p.id ORDER BY update_date DESC LIMIT 1) as latest_update_date,
      CASE WHEN up.portfolio_id IS NOT NULL THEN 1 ELSE 0 END as is_pinned,
      CASE
        WHEN p.last_update_at IS NOT NULL
          AND julianday('now') - julianday(p.last_update_at) > ?
        THEN 1 ELSE 0
      END as is_stale_warning
    FROM portfolios p
    LEFT JOIN user_pins up ON up.portfolio_id = p.id AND up.telegram_id = ?
    WHERE p.status != 'archived'
  `;

  const binds: any[] = [threshold, userId];

  if (status) {
    query += ` AND p.status = ?`;
    binds.push(status);
  }

  query += " ORDER BY is_pinned DESC, p.name ASC";
  const { results } = await c.env.DB.prepare(query).bind(...binds).all();
  return c.json(results);
});

// ─── Pin/Unpin API ───

app.post("/api/portfolios/:id/pin", authMiddleware, async (c) => {
  const portfolioId = c.req.param("id");
  const user = c.get("user") as any;
  const userId = String(user.id);

  // Enforce pin limit
  const { results: existing } = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_pins WHERE telegram_id = ?"
  ).bind(userId).all();
  if ((existing[0] as any)?.cnt >= MAX_PINS_PER_USER) {
    return c.json({ error: `최대 ${MAX_PINS_PER_USER}개까지 핀 가능합니다` }, 400);
  }

  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO user_pins (telegram_id, portfolio_id) VALUES (?, ?)"
  ).bind(userId, portfolioId).run();

  return c.json({ ok: true, pinned: true });
});

app.delete("/api/portfolios/:id/pin", authMiddleware, async (c) => {
  const portfolioId = c.req.param("id");
  const user = c.get("user") as any;
  const userId = String(user.id);

  await c.env.DB.prepare(
    "DELETE FROM user_pins WHERE telegram_id = ? AND portfolio_id = ?"
  ).bind(userId, portfolioId).run();

  return c.json({ ok: true, pinned: false });
});

app.post("/api/portfolios", authMiddleware, async (c) => {
  const body = await c.req.json<any>();
  const user = c.get("user") as any;

  if (!body.name?.trim()) return c.json({ error: "Name required" }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO portfolios (name, status, assignee_name, assignee_telegram_id, logo_url)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    body.name.trim(),
    body.status || "active",
    body.assignee_name ||
      `${user.first_name} ${user.last_name || ""}`.trim(),
    String(user.id),
    body.logo_url || null
  ).run();

  return c.json({ id: result.meta.last_row_id }, 201);
});

app.put("/api/portfolios/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<any>();

  const existing = await c.env.DB.prepare(
    "SELECT id FROM portfolios WHERE id = ?"
  ).bind(id).first();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const sets: string[] = [];
  const values: any[] = [];

  if (body.name !== undefined) {
    sets.push("name = ?");
    values.push(body.name);
  }
  if (body.status !== undefined) {
    sets.push("status = ?");
    values.push(body.status);
    // Auto-unpin all users when moved out of active
    if (body.status !== "active") {
      await c.env.DB.prepare(
        "DELETE FROM user_pins WHERE portfolio_id = ?"
      ).bind(id).run();
    }
  }
  if (body.assignee_name !== undefined) {
    sets.push("assignee_name = ?");
    values.push(body.assignee_name);
  }
  if (body.assignee_telegram_id !== undefined) {
    sets.push("assignee_telegram_id = ?");
    values.push(body.assignee_telegram_id);
  }
  if (body.logo_url !== undefined) {
    sets.push("logo_url = ?");
    values.push(body.logo_url);
  }

  if (sets.length === 0)
    return c.json({ error: "No fields to update" }, 400);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  await c.env.DB.prepare(
    `UPDATE portfolios SET ${sets.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  return c.json({ ok: true });
});

app.delete("/api/portfolios/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  // Soft delete + unpin
  await c.env.DB.prepare(
    "DELETE FROM user_pins WHERE portfolio_id = ?"
  ).bind(id).run();
  await c.env.DB.prepare(
    "UPDATE portfolios SET status = 'archived', updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return c.json({ ok: true });
});

// ─── Portfolio Updates API ───

app.get("/api/portfolios/:id/updates", authMiddleware, async (c) => {
  const portfolioId = c.req.param("id");

  const { results: updates } = await c.env.DB.prepare(
    `SELECT u.*,
       json_group_array(json_object(
         'id', a.id, 'file_name', a.file_name,
         'file_type', a.file_type, 'gdrive_url', a.gdrive_url
       )) as attachments_json
     FROM portfolio_updates u
     LEFT JOIN attachments a ON a.update_id = u.id
     WHERE u.portfolio_id = ?
     GROUP BY u.id
     ORDER BY u.update_date DESC`
  ).bind(portfolioId).all();

  const parsed = updates.map((u: any) => ({
    ...u,
    attachments: JSON.parse(u.attachments_json).filter(
      (a: any) => a.id !== null
    ),
    attachments_json: undefined,
  }));

  return c.json(parsed);
});

app.post("/api/portfolios/:id/updates", authMiddleware, async (c) => {
  const portfolioId = c.req.param("id");
  const user = c.get("user") as any;

  const formData = await c.req.formData();
  const title = formData.get("title") as string;
  const summary = formData.get("summary") as string;
  const updateDate = formData.get("update_date") as string;
  const gdriveLinks = formData.getAll("gdrive_link") as string[];

  if (!title?.trim()) return c.json({ error: "Title required" }, 400);

  const portfolio = await c.env.DB.prepare(
    "SELECT * FROM portfolios WHERE id = ?"
  ).bind(portfolioId).first<any>();
  if (!portfolio) return c.json({ error: "Portfolio not found" }, 404);

  const authorName = `${user.first_name} ${user.last_name || ""}`.trim();
  const dateValue = updateDate || new Date().toISOString().split("T")[0];

  const result = await c.env.DB.prepare(
    `INSERT INTO portfolio_updates (portfolio_id, author_name, author_telegram_id, title, summary, update_date)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    portfolioId,
    authorName,
    String(user.id),
    title.trim(),
    summary?.trim() || null,
    dateValue
  ).run();

  const updateId = result.meta.last_row_id;
  const attachments: any[] = [];

  // Handle file uploads to Google Drive
  const files = formData.getAll("files") as File[];
  if (files.length > 0 && c.env.GDRIVE_SERVICE_ACCOUNT_KEY) {
    try {
      const accessToken = await getGDriveAccessToken(
        c.env.GDRIVE_SERVICE_ACCOUNT_KEY
      );

      let folderId = portfolio.gdrive_folder_id;
      if (!folderId) {
        folderId = await createGDriveFolder(
          accessToken,
          `ABC_Portfolio_${portfolio.name}`,
          c.env.GDRIVE_ROOT_FOLDER_ID
        );
        await c.env.DB.prepare(
          "UPDATE portfolios SET gdrive_folder_id = ? WHERE id = ?"
        ).bind(folderId, portfolioId).run();
      }

      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) continue;
        const uploaded = await uploadToGDrive(
          accessToken,
          file,
          folderId,
          `${dateValue}_${file.name}`
        );

        await c.env.DB.prepare(
          `INSERT INTO attachments (update_id, file_name, file_type, gdrive_url, gdrive_file_id)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(updateId, file.name, file.type, uploaded.url, uploaded.id).run();

        attachments.push({ file_name: file.name, gdrive_url: uploaded.url });
      }
    } catch (e: any) {
      console.error("GDrive upload error:", e?.message || e);
    }
  }

  // Handle manual GDrive links
  for (const link of gdriveLinks) {
    if (!link?.trim()) continue;
    await c.env.DB.prepare(
      `INSERT INTO attachments (update_id, file_name, file_type, gdrive_url, gdrive_file_id)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(updateId, "Google Drive Link", "link", link.trim(), "manual").run();
    attachments.push({ file_name: "Link", gdrive_url: link.trim() });
  }

  // Update portfolio timestamp
  await c.env.DB.prepare(
    "UPDATE portfolios SET last_update_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).bind(portfolioId).run();

  // Bot notification (non-blocking)
  try {
    const attachText =
      attachments.length > 0 ? `\n📎 첨부 ${attachments.length}건` : "";
    await notifyGroup(
      c.env,
      `📋 <b>${portfolio.name}</b> — 새 업데이트\n제목: ${title}${attachText}\n작성: ${authorName}`,
      `#/portfolio/${portfolioId}`
    );
  } catch {
    // Non-critical: notification failure doesn't affect update save
  }

  return c.json({ id: updateId, attachments }, 201);
});

app.delete("/api/portfolios/:id/updates/:updateId", authMiddleware, async (c) => {
  const updateId = c.req.param("updateId");

  // Delete files from Google Drive
  if (c.env.GDRIVE_SERVICE_ACCOUNT_KEY) {
    try {
      const { results: atts } = await c.env.DB.prepare(
        "SELECT gdrive_file_id FROM attachments WHERE update_id = ? AND gdrive_file_id != 'manual'"
      ).bind(updateId).all();

      if (atts.length > 0) {
        const accessToken = await getGDriveAccessToken(
          c.env.GDRIVE_SERVICE_ACCOUNT_KEY
        );
        for (const att of atts) {
          await deleteFromGDrive(accessToken, (att as any).gdrive_file_id);
        }
      }
    } catch (e: any) {
      console.error("GDrive delete error:", e?.message || e);
    }
  }

  await c.env.DB.prepare(
    "DELETE FROM attachments WHERE update_id = ?"
  ).bind(updateId).run();
  await c.env.DB.prepare(
    "DELETE FROM portfolio_updates WHERE id = ?"
  ).bind(updateId).run();

  // Recalculate portfolio's last_update_at
  const portfolioId = c.req.param("id");
  await c.env.DB.prepare(`
    UPDATE portfolios SET last_update_at = (
      SELECT MAX(update_date) FROM portfolio_updates WHERE portfolio_id = ?
    ) WHERE id = ?
  `).bind(portfolioId, portfolioId).run();

  return c.json({ ok: true });
});

// ─── File upload (standalone) ───

app.post("/api/files/upload", authMiddleware, async (c) => {
  if (!c.env.GDRIVE_SERVICE_ACCOUNT_KEY) {
    return c.json({ error: "Google Drive not configured" }, 500);
  }

  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  const folderId = formData.get("folder_id") as string;

  if (!file) return c.json({ error: "File required" }, 400);
  if (file.size > MAX_FILE_SIZE)
    return c.json({ error: "File too large (max 25MB)" }, 400);

  const accessToken = await getGDriveAccessToken(
    c.env.GDRIVE_SERVICE_ACCOUNT_KEY
  );
  const uploaded = await uploadToGDrive(
    accessToken,
    file,
    folderId || c.env.GDRIVE_ROOT_FOLDER_ID,
    file.name
  );

  return c.json(uploaded);
});

// ─── App info ───

app.get("/api/info", (c) => {
  return c.json({ version: APP_VERSION });
});

// ─── Telegram Bot webhook ───

app.post("/api/webhook", async (c) => {
  const update = await c.req.json<any>();
  const text = update.message?.text;
  const chatId = update.message?.chat?.id;

  if (!text || !chatId) return c.json({ ok: true });

  if (text === "/start") {
    await sendBotMessage(c.env.BOT_TOKEN, chatId, "ABC Pulse 📊\n\n포트폴리오 현황을 확인하세요.", {
      reply_markup: {
        inline_keyboard: [[
          {
            text: "📊 Portfolio Pulse",
            web_app: {
              url: c.env.MINI_APP_URL || "https://abc-board.oddrecord7079.workers.dev",
            },
          },
        ]],
      },
    });
  }

  if (text === "/stale") {
    const threshold = parseInt(c.env.STALE_THRESHOLD_DAYS || "60");
    const results = await getStalePortfolios(c.env.DB, threshold);

    if (results.length === 0) {
      await sendBotMessage(c.env.BOT_TOKEN, chatId, "✅ 미갱신 포트폴리오가 없습니다!");
    } else {
      const list = results
        .map((r: any) => `• ${r.name} (${r.days_since}일 미갱신)`)
        .join("\n");
      await sendBotMessage(
        c.env.BOT_TOKEN,
        chatId,
        `⚠️ 확인필요 포트폴리오 ${results.length}건\n\n${list}`,
        { parse_mode: "HTML" }
      );
    }
  }

  return c.json({ ok: true });
});

// ─── Static files ───
app.use("/*", serveStatic({ root: "./", manifest }));
app.get("*", serveStatic({ path: "./index.html", manifest }));

// ─── Cron: Weekly stale reminder ───

export default {
  fetch: app.fetch,
  async scheduled(
    event: ScheduledEvent,
    env: Bindings,
    ctx: ExecutionContext
  ) {
    const threshold = parseInt(env.STALE_THRESHOLD_DAYS || "60");
    const results = await getStalePortfolios(env.DB, threshold);

    if (results.length > 0) {
      const list = results
        .map((r: any) => `• ${r.name} (${r.days_since}일 미갱신)`)
        .join("\n");
      await notifyGroup(
        env,
        `⚠️ 주간 포트폴리오 점검\n확인필요 ${results.length}건\n\n${list}`,
        "#/"
      );
    }
  },
};
