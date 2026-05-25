const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, ".env"),
  override: true,
});

const express = require("express");
const cors = require("cors");
const connectDB = require("./src/config/db");
const migrateInvalidResponsiblePersons = require("./src/config/migrateTeam");
const {
  configureCloudinary,
  getCloudName,
} = require("./src/config/cloudinary");
const leadsRouter = require("./src/routes/leads");
const teamRouter = require("./src/routes/team");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

app.use(express.json());

const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sales CRM API</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: system-ui, -apple-system, sans-serif;
      background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%);
      color: #fff;
      padding: 24px;
    }
    .card {
      max-width: 480px;
      width: 100%;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 16px;
      padding: 40px 32px;
      text-align: center;
      backdrop-filter: blur(8px);
    }
    .badge {
      display: inline-block;
      background: #22c55e;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 6px 14px;
      border-radius: 999px;
      margin-bottom: 20px;
    }
    h1 { font-size: 26px; margin-bottom: 10px; }
    p { color: #94a3b8; font-size: 15px; line-height: 1.6; margin-bottom: 28px; }
    a.btn {
      display: inline-block;
      background: #10b981;
      color: #fff;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      padding: 12px 28px;
      border-radius: 10px;
      transition: background 0.2s;
    }
    a.btn:hover { background: #059669; }
    .meta { margin-top: 24px; font-size: 12px; color: #64748b; }
    .meta code { background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Connected</div>
    <h1>Sales CRM API</h1>
    <p>Backend is running. Open the app below to manage leads and the Activity board.</p>
    <a class="btn" href="${clientUrl}">Open Sales CRM App &rarr;</a>
    <p class="meta">API: <code>/api/health</code> &nbsp;|&nbsp; App: <code>${clientUrl}</code></p>
    <p class="meta" style="margin-top:12px">Redirecting to app in <span id="s">5</span>s…</p>
  </div>
  <script>
    var n = 5, el = document.getElementById("s");
    var t = setInterval(function () {
      n--; if (el) el.textContent = n;
      if (n <= 0) { clearInterval(t); window.location.href = "${clientUrl}"; }
    }, 1000);
  </script>
</body>
</html>`);
});

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "Sales CRM Server Connected Successfully 🚀",
  });
});

app.use("/api/leads", leadsRouter);
app.use("/api/team", teamRouter);

async function start() {
  try {
    if (configureCloudinary()) {
      console.log(
        `Cloudinary connected (cloud: ${getCloudName()}) for document uploads`
      );
    } else {
      console.warn(
        "Cloudinary NOT configured — add CLOUD_NAME, CLOUD_API_KEY, CLOUD_API_SECRET to backend/.env"
      );
    }

    await connectDB();
    await migrateInvalidResponsiblePersons();

    app.listen(PORT, () => {
      console.log(
        `🚀 Sales CRM Server Connected Successfully on http://localhost:${PORT}`
      );
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

start();

