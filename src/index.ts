import { Hono } from "hono";
import { serveStatic } from "hono/cloudflare-workers";
import { cors } from "hono/cors";
// @ts-ignore
import manifest from "__STATIC_CONTENT_MANIFEST";

type Bindings = {
  DB: D1Database;
  BOT_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", cors());

// ─── Posts API ───

app.get("/api/posts", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
     FROM posts p ORDER BY p.created_at DESC`
  ).all();
  return c.json(results);
});

app.get("/api/posts/:id", async (c) => {
  const id = c.req.param("id");
  const post = await c.env.DB.prepare("SELECT * FROM posts WHERE id = ?")
    .bind(id)
    .first();
  if (!post) return c.json({ error: "Not found" }, 404);

  const { results: comments } = await c.env.DB.prepare(
    "SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC"
  )
    .bind(id)
    .all();

  return c.json({ ...post, comments });
});

app.post("/api/posts", async (c) => {
  const body = await c.req.json<{
    title: string;
    content: string;
    author_name: string;
    author_id: number;
  }>();

  if (!body.title?.trim() || !body.content?.trim()) {
    return c.json({ error: "Title and content required" }, 400);
  }

  const result = await c.env.DB.prepare(
    "INSERT INTO posts (title, content, author_name, author_id) VALUES (?, ?, ?, ?)"
  )
    .bind(body.title.trim(), body.content.trim(), body.author_name, body.author_id)
    .run();

  return c.json({ id: result.meta.last_row_id }, 201);
});

app.delete("/api/posts/:id", async (c) => {
  const id = c.req.param("id");
  const authorId = c.req.query("author_id");

  const post = await c.env.DB.prepare("SELECT author_id FROM posts WHERE id = ?")
    .bind(id)
    .first<{ author_id: number }>();

  if (!post) return c.json({ error: "Not found" }, 404);
  if (String(post.author_id) !== authorId) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  await c.env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ─── Comments API ───

app.post("/api/posts/:id/comments", async (c) => {
  const postId = c.req.param("id");
  const body = await c.req.json<{
    content: string;
    author_name: string;
    author_id: number;
  }>();

  if (!body.content?.trim()) {
    return c.json({ error: "Content required" }, 400);
  }

  const post = await c.env.DB.prepare("SELECT id FROM posts WHERE id = ?")
    .bind(postId)
    .first();
  if (!post) return c.json({ error: "Post not found" }, 404);

  const result = await c.env.DB.prepare(
    "INSERT INTO comments (post_id, content, author_name, author_id) VALUES (?, ?, ?, ?)"
  )
    .bind(postId, body.content.trim(), body.author_name, body.author_id)
    .run();

  return c.json({ id: result.meta.last_row_id }, 201);
});

app.delete("/api/comments/:id", async (c) => {
  const id = c.req.param("id");
  const authorId = c.req.query("author_id");

  const comment = await c.env.DB.prepare(
    "SELECT author_id FROM comments WHERE id = ?"
  )
    .bind(id)
    .first<{ author_id: number }>();

  if (!comment) return c.json({ error: "Not found" }, 404);
  if (String(comment.author_id) !== authorId) {
    return c.json({ error: "Unauthorized" }, 403);
  }

  await c.env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ─── Telegram Bot webhook ───

app.post("/api/webhook", async (c) => {
  const update = await c.req.json<any>();

  if (update.message?.text === "/start") {
    const chatId = update.message.chat.id;
    await fetch(
      `https://api.telegram.org/bot${c.env.BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Welcome to ABC Partners! 🏢\n\nTap the button below to open our board.",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "📋 Open Board",
                  web_app: { url: "https://app.abc-partners.com" },
                },
              ],
            ],
          },
        }),
      }
    );
  }

  return c.json({ ok: true });
});

// ─── Static files ───
app.use("/*", serveStatic({ root: "./", manifest }));

// Fallback to index.html for SPA routing
app.get("*", serveStatic({ path: "./index.html", manifest }));

export default app;
