const express = require("express");
const Supplier = require("../models/Supplier");
const User = require("../models/User");
const {
  pickSupplierFields,
  supplierToClientResponse,
} = require("../lib/supplierAdapter");

const router = express.Router();

/** All authenticated users see and manage the shared supplier list. */
function supplierFilter(extra = {}) {
  return { ...extra };
}

router.get("/", async (req, res) => {
  try {
    const suppliers = await Supplier.find(supplierFilter()).sort({
      updatedAt: -1,
    });
    res.json(suppliers.map(supplierToClientResponse));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const supplier = await Supplier.findOne(
      supplierFilter({ _id: req.params.id })
    );
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    res.json(supplierToClientResponse(supplier));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const creator = await User.findById(req.userId).select("name role");
    const fields = pickSupplierFields(req.body);

    if (creator?.name) {
      const creatorName = creator.name.trim();
      if (!req.isAdmin) {
        fields.responsiblePerson = creatorName;
      } else if (!String(fields.responsiblePerson || "").trim()) {
        fields.responsiblePerson = creatorName;
      }
    }

    const supplier = await Supplier.create({
      ...fields,
      createdBy: req.userId,
    });
    res.status(201).json(supplierToClientResponse(supplier));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const fields = pickSupplierFields(req.body);
    delete fields.createdBy;

    const supplier = await Supplier.findOneAndUpdate(
      supplierFilter({ _id: req.params.id }),
      fields,
      { new: true, runValidators: true }
    );
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }
    res.json(supplierToClientResponse(supplier));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
