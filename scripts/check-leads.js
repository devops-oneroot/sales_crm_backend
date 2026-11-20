require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const mongoose = require("mongoose");
const Lead = require("../src/models/Lead");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db.databaseName;
  const total = await Lead.countDocuments();
  const statuses = await Lead.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const inProgressPipeline = await Lead.find({
    pipelineStatus: "in_progress",
  })
    .select("status pipelineStatus responsiblePerson company name")
    .lean();
  const inProgressStatus = await Lead.find({ status: "in_progress" })
    .select("status pipelineStatus responsiblePerson company name")
    .lean();
  console.log("DB:", db);
  console.log("Total leads:", total);
  console.log("By status:", statuses);
  console.log("Still in_progress status:", inProgressStatus.length);
  console.log("pipelineStatus in_progress:", inProgressPipeline.length);
  if (inProgressPipeline.length) {
    console.log("Sample pipeline in_progress:", inProgressPipeline.slice(0, 3));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
