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
const matchRouter = require("./src/routes/match");
const activityRouter = require("./src/routes/activity");
const dailyPricesRouter = require("./src/routes/dailyPrices");

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
app.use("/api/match", requireAuth, matchRouter);
app.use("/api/activity", requireAuth, activityRouter);
app.use("/api/daily-prices", requireAuth, dailyPricesRouter);

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

