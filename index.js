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

