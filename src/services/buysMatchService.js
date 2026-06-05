const Lead = require("../models/Lead");
const Supplier = require("../models/Supplier");
const { extractSupplierForMatch } = require("../lib/supplierAdapter");
const { buyerLeadClause } = require("../lib/leadQuery");

const WEIGHTS = {
  polish: 30,
  material: 25,
  curcumin: 20,
  price: 15,
  origin: 10,
};

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeLabel(value) {
  return String(value ?? "").trim();
}

function scoreString(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return null;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 75;
  return 0;
}

function scoreCurcumin(supplierPercent, leadMin) {
  const supplier = Number(supplierPercent);
  const minimum = Number(leadMin);
  if (!Number.isFinite(supplier) || supplier <= 0) return null;
  if (!Number.isFinite(minimum) || minimum <= 0) return null;
  if (supplier >= minimum) return 100;
  return Math.max(0, Math.min(100, (supplier / minimum) * 100));
}

function scorePrice(supplierPrice, leadMaxPrice) {
  const price = Number(supplierPrice);
  const maxPrice = Number(leadMaxPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) return null;
  if (price <= maxPrice) return 100;
  return Math.max(0, Math.min(100, (maxPrice / price) * 100));
}

function resolvePositiveNumber(...candidates) {
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Trade max price: exportDetails.maxPrice, else product list price (legacy data). */
function resolveLeadMaxPrice(lead) {
  const ed = lead.exportDetails || {};
  return resolvePositiveNumber(
    ed.maxPrice,
    lead.product?.price,
    lead.products?.[0]?.price
  );
}

function scoreOrigin(supplier, lead) {
  const origins = [
    supplier.variety,
    supplier.region,
    lead.preferredOrigin,
    lead.sourcingRegion,
  ]
    .map(normalizeLabel)
    .filter(Boolean);

  if (origins.length < 2) return null;

  const supplierOrigin = normalizeLabel(supplier.variety || supplier.region);
  const leadOrigin = normalizeLabel(
    lead.preferredOrigin || lead.sourcingRegion
  );
  if (!supplierOrigin || !leadOrigin) return null;

  return scoreString(supplierOrigin, leadOrigin) ?? 0;
}

function extractBuyer(lead) {
  const ed = lead.exportDetails || {};
  const maxPrice = resolveLeadMaxPrice(lead);
  return {
    id: String(lead._id),
    name: lead.company?.trim() || lead.name?.trim() || "Unnamed lead",
    leadType: lead.leadType === "export" ? "export" : "domestic",
    polishLevel: ed.polishLevel,
    materialType: ed.materialType,
    minCurcumin: ed.minCurcumin,
    maxPrice,
    preferredOrigin: ed.preferredOrigin,
    sourcingRegion: lead.sourcingRegion,
    acceptGrade: ed.acceptGrade,
    quantityNeededKg: ed.quantityNeededKg,
    status: lead.status,
    responsiblePerson: lead.responsiblePerson,
  };
}

function computeMatch(supplier, buyer) {
  const breakdown = {
    polish: scoreString(supplier.polishLevel, buyer.polishLevel),
    material: scoreString(supplier.materialType, buyer.materialType),
    curcumin: scoreCurcumin(supplier.curcuminPercent, buyer.minCurcumin),
    price: scorePrice(supplier.price, buyer.maxPrice),
    origin: scoreOrigin(supplier, buyer),
  };

  let totalWeight = 0;
  let weightedSum = 0;
  const matchedFields = [];
  const unmatchedFields = [];

  for (const [field, weight] of Object.entries(WEIGHTS)) {
    const score = breakdown[field];
    if (score === null) continue;
    totalWeight += weight;
    weightedSum += score * weight;
    if (score >= 60) {
      matchedFields.push(field);
    } else {
      unmatchedFields.push(field);
    }
  }

  const matchScore =
    totalWeight > 0
      ? Number((weightedSum / totalWeight).toFixed(1))
      : 0;

  const scoredBreakdown = {};
  for (const [field, score] of Object.entries(breakdown)) {
    if (score !== null) {
      scoredBreakdown[field] = Number(score.toFixed(1));
    }
  }

  return {
    leadId: buyer.id,
    leadName: buyer.name,
    leadType: buyer.leadType,
    leadStatus: buyer.status,
    responsiblePerson: buyer.responsiblePerson,
    matchScore,
    matchedFields,
    unmatchedFields,
    breakdown: scoredBreakdown,
    supplierSnapshot: {
      polishLevel: supplier.polishLevel,
      materialType: supplier.materialType,
      curcuminPercent: supplier.curcuminPercent,
      price: supplier.price,
      origin: supplier.variety || supplier.region,
    },
    leadSnapshot: {
      polishLevel: buyer.polishLevel,
      materialType: buyer.materialType,
      minCurcumin: buyer.minCurcumin,
      maxPrice: buyer.maxPrice,
      preferredOrigin: buyer.preferredOrigin || buyer.sourcingRegion,
    },
  };
}

function buildSupplierMatchEntry(supplier, match) {
  return {
    supplierId: supplier.id,
    supplierName: supplier.name,
    supplierDetails: {
      supplierNumber: supplier.supplierNumber,
      polishLevel: supplier.polishLevel,
      materialType: supplier.materialType,
      curcuminPercent: supplier.curcuminPercent,
      price: supplier.price,
      region: supplier.region,
      variety: supplier.variety,
      grade: supplier.grade,
      quantityKg: supplier.quantityKg,
    },
    leadId: match.leadId,
    leadName: match.leadName,
    leadType: match.leadType,
    leadStatus: match.leadStatus,
    responsiblePerson: match.responsiblePerson,
    matchScore: match.matchScore,
    matchedFields: match.matchedFields,
    unmatchedFields: match.unmatchedFields,
    breakdown: match.breakdown,
    supplierSnapshot: match.supplierSnapshot,
    leadSnapshot: match.leadSnapshot,
  };
}

function buildLeadRow(buyer, suppliers, minScore, limitMatches = 15) {
  const allMatches = suppliers
    .map((supplier) => ({
      supplier,
      match: computeMatch(supplier, buyer),
    }))
    .sort((a, b) => b.match.matchScore - a.match.matchScore);

  const qualifying = allMatches.filter((m) => m.match.matchScore >= minScore);
  const bestEntry = qualifying[0];

  return {
    leadId: buyer.id,
    leadName: buyer.name,
    leadType: buyer.leadType,
    leadStatus: buyer.status,
    responsiblePerson: buyer.responsiblePerson,
    leadDetails: {
      polishLevel: buyer.polishLevel,
      materialType: buyer.materialType,
      minCurcumin: buyer.minCurcumin,
      maxPrice: buyer.maxPrice,
      preferredOrigin: buyer.preferredOrigin || buyer.sourcingRegion,
      acceptGrade: buyer.acceptGrade,
      quantityNeededKg: buyer.quantityNeededKg,
    },
    matchCount: qualifying.length,
    bestMatch: bestEntry
      ? buildSupplierMatchEntry(bestEntry.supplier, bestEntry.match)
      : null,
    matches: qualifying
      .slice(0, limitMatches)
      .map((entry) => buildSupplierMatchEntry(entry.supplier, entry.match)),
  };
}

/** All users match against the full supplier and lead pools. */
function supplierFilter() {
  return {};
}

function buyerFilter() {
  return buyerLeadClause();
}

async function getMatches(req, options = {}) {
  const minScore = Number(options.minScore) || 0;
  const limitPerSupplier = Math.min(
    50,
    Math.max(1, Number(options.limit) || 15)
  );

  const [supplierDocs, buyerDocs] = await Promise.all([
    Supplier.find(supplierFilter()).sort({ updatedAt: -1 }).lean(),
    Lead.find(buyerFilter()).sort({ updatedAt: -1 }).lean(),
  ]);

  const suppliers = supplierDocs.map(extractSupplierForMatch);
  const buyers = buyerDocs.map(extractBuyer);

  const results = suppliers.map((supplier) => {
    const matches = buyers
      .map((buyer) => computeMatch(supplier, buyer))
      .filter((match) => match.matchScore >= minScore)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limitPerSupplier);

    return {
      supplierId: supplier.id,
      supplierName: supplier.name,
      supplierDetails: {
        supplierNumber: supplier.supplierNumber,
        polishLevel: supplier.polishLevel,
        materialType: supplier.materialType,
        curcuminPercent: supplier.curcuminPercent,
        price: supplier.price,
        region: supplier.region,
        variety: supplier.variety,
        grade: supplier.grade,
        quantityKg: supplier.quantityKg,
      },
      matchCount: matches.length,
      bestMatch: matches[0] ?? null,
      matches,
    };
  });

  results.sort((a, b) => {
    const scoreA = a.bestMatch?.matchScore ?? 0;
    const scoreB = b.bestMatch?.matchScore ?? 0;
    return scoreB - scoreA;
  });

  const withMatches = results.filter((row) => row.matchCount > 0);
  const topScores = withMatches
    .map((row) => row.bestMatch?.matchScore ?? 0)
    .filter((score) => score > 0);

  return {
    suppliers: results,
    summary: {
      supplierCount: suppliers.length,
      buyerCount: buyers.length,
      suppliersWithMatches: withMatches.length,
      avgBestScore: topScores.length
        ? Number(
            (
              topScores.reduce((sum, score) => sum + score, 0) /
              topScores.length
            ).toFixed(1)
          )
        : 0,
    },
  };
}

async function getLeadMatches(req, options = {}) {
  const minScore = Number(options.minScore) || 0;
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(
    50,
    Math.max(1, Number(options.pageSize) || 10)
  );
  const limitMatches = Math.min(
    50,
    Math.max(1, Number(options.limit) || 15)
  );

  const [supplierDocs, buyerDocs] = await Promise.all([
    Supplier.find(supplierFilter()).sort({ updatedAt: -1 }).lean(),
    Lead.find(buyerFilter()).sort({ updatedAt: -1 }).lean(),
  ]);

  const suppliers = supplierDocs.map(extractSupplierForMatch);
  const buyers = buyerDocs.map(extractBuyer);

  const allRows = buyers
    .map((buyer) => buildLeadRow(buyer, suppliers, minScore, limitMatches))
    .sort((a, b) => {
      const scoreA = a.bestMatch?.matchScore ?? -1;
      const scoreB = b.bestMatch?.matchScore ?? -1;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.leadName.localeCompare(b.leadName);
    });

  const total = allRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const leads = allRows.slice(start, start + pageSize);

  const withMatches = allRows.filter((row) => row.bestMatch);
  const topScores = withMatches
    .map((row) => row.bestMatch?.matchScore ?? 0)
    .filter((score) => score > 0);

  return {
    leads,
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
    },
    summary: {
      supplierCount: suppliers.length,
      buyerCount: buyers.length,
      leadsWithMatches: withMatches.length,
      leadsWithoutMatches: total - withMatches.length,
      avgBestScore: topScores.length
        ? Number(
            (
              topScores.reduce((sum, score) => sum + score, 0) /
              topScores.length
            ).toFixed(1)
          )
        : 0,
    },
  };
}

module.exports = { getMatches, getLeadMatches, WEIGHTS };
