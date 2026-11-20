const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, ".env"),
  override: true,
});

const express = require("express");
const cors = require("cors");
const connectDB = require("./src/config/db");
const migrateInvalidResponsiblePersons = require("./src/config/migrateTeam");
const migrateLeadCreators = require("./src/config/migrateLeadCreators");
const migrateAdmin = require("./src/config/migrateAdmin");
const migrateSuppliers = require("./src/config/migrateSuppliers");
const migrateLeadTypes = require("./src/config/migrateLeadTypes");
const migrateLeadStatuses = require("./src/config/migrateLeadStatuses");
const {
  configureCloudinary,
  getCloudName,
} = require("./src/config/cloudinary");
const authRouter = require("./src/routes/auth");
const { requireAuth } = require("./src/middleware/auth");
const leadsRouter = require("./src/routes/leads");
const locationsRouter = require("./src/routes/locations");
const teamRouter = require("./src/routes/team");
const suppliersRouter = require("./src/routes/suppliers");
const importersRouter = require("./src/routes/importers");
const matchRouter = require("./src/routes/match");
const activityRouter = require("./src/routes/activity");
const dailyPricesRouter = require("./src/routes/dailyPrices");
const tasksRouter = require("./src/routes/tasks");
const emailsRouter = require("./src/routes/emails");
const linkedinRouter = require("./src/routes/linkedin");
const { syncLinkedInLeads } = require("./src/services/linkedInScraperService");
const { getDiscoverySchedule } = require("./src/services/discoveryService");
const { reschedule: rescheduleDiscovery } = require("./src/services/discoveryScheduler");
const { router: outreachRouter, publicRouter: outreachPublicRouter } = require("./src/routes/outreach");
const { startOutreachScheduler } = require("./src/services/outreachEngine");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "Sales CRM Server Connected Successfully 🚀",
  });
});

app.use("/api/auth", authRouter);
app.use("/api/leads", requireAuth, leadsRouter);
app.use("/api/locations", requireAuth, locationsRouter);
app.use("/api/team", requireAuth, teamRouter);
app.use("/api/suppliers", requireAuth, suppliersRouter);
app.use("/api/importers", requireAuth, importersRouter);
app.use("/api/match", requireAuth, matchRouter);
app.use("/api/activity", requireAuth, activityRouter);
app.use("/api/daily-prices", requireAuth, dailyPricesRouter);
app.use("/api/tasks", requireAuth, tasksRouter);
app.use("/api/emails", requireAuth, emailsRouter);
app.use("/api/linkedin", requireAuth, linkedinRouter);
// Unsubscribe links in outreach emails must work without logging in.
app.use("/api/outreach/unsubscribe", outreachPublicRouter);
app.use("/api/outreach", requireAuth, outreachRouter);

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
    await migrateLeadCreators();
    await migrateAdmin();
    await migrateSuppliers();
    await migrateLeadTypes();
    await migrateLeadStatuses();
    // Disabled: seedVietnamImporters() inserted a hard-coded importer list with no
    // source_url/fetched_at, and startScraperScheduler() ran the legacy scraper that
    // generated phone numbers and emails. Both violate "never invent lead data".
    // Importers → Discovery is the supported ingest path.
    await syncLinkedInLeads({ triggerType: "scheduled" }).catch((e) =>
      console.warn("LinkedIn sync warning:", e.message)
    );
    // Web discovery scheduler is disabled (buyers only added via CSV/Excel or manual entry)
    // Automated outreach scheduler disabled (queued for future enhancement)
    // startOutreachScheduler();

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

