const STOCK_TYPES = ["finger", "bulk", "mother", "kocha"];

const STOCK_POLISH_OPTIONS = ["single_polish", "unpolish", "double_polish"];

const STOCK_TYPE_LABELS = {
  finger: "Finger",
  bulk: "Bulk",
  mother: "Mother",
  kocha: "Kocha",
};

const STOCK_POLISH_LABELS = {
  single_polish: "Single polish",
  unpolish: "Unpolish",
  double_polish: "Double polish",
};

function isValidStockType(value) {
  return STOCK_TYPES.includes(value);
}

function isValidStockPolish(value) {
  return STOCK_POLISH_OPTIONS.includes(value);
}

module.exports = {
  STOCK_TYPES,
  STOCK_POLISH_OPTIONS,
  STOCK_TYPE_LABELS,
  STOCK_POLISH_LABELS,
  isValidStockType,
  isValidStockPolish,
};
