export type MenuImportRow = {
  id: string;
  category: string;
  name: string;
  priceRupees: number;
  description: string;
  dietaryType: "veg" | "non-veg";
};

const MAX_IMPORT_ROWS = 400;
const HEADER_NAMES = ["name", "dish", "dish name", "item", "item name", "menu item", "food item", "product"];
const HEADER_PRICES = ["price", "amount", "rate", "mrp", "selling price", "price inr", "amount inr"];
const HEADER_CATEGORIES = ["category", "category name", "section", "group", "menu category"];
const HEADER_DESCRIPTIONS = ["description", "details", "ingredients", "notes", "note"];
const HEADER_DIETARY = ["dietary type", "dietary", "food type", "type", "veg non veg"];

function toText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(" ");
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.richText)) return toText(record.richText.map((part) => typeof part === "object" && part !== null ? (part as Record<string, unknown>).text : ""));
  if ("result" in record) return toText(record.result);
  if ("text" in record) return toText(record.text);
  return "";
}

function normalizedHeader(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function parsePrice(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const normalized = toText(value).replace(/(?:INR|Rs\.?|₹)/gi, "").replace(/,/g, "").trim();
  const match = normalized.match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseDietary(value: string): "veg" | "non-veg" {
  const normalized = normalizedHeader(value).replace(/[\s-]/g, "");
  return ["nonveg", "nonvegetarian", "nonvegetarianfood", "nv"].includes(normalized) ? "non-veg" : "veg";
}

function makeRow(category: string, name: string, priceRupees: number, description = "", dietaryType = "veg"): MenuImportRow {
  return {
    id: crypto.randomUUID(),
    category: category.trim() || "Imported Menu",
    name: name.trim(),
    priceRupees,
    description: description.trim(),
    dietaryType: parseDietary(dietaryType),
  };
}

function findColumn(headers: string[], aliases: string[]) {
  const match = headers.findIndex((header) => aliases.includes(normalizedHeader(header)));
  return match < 0 ? -1 : match;
}

async function parseXlsx(file: File): Promise<MenuImportRow[]> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer() as never);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("This workbook has no worksheets.");

  let headerRow = 0;
  let columns = { category: -1, name: -1, price: -1, description: -1, dietary: -1 };
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 12); rowNumber += 1) {
    const headerData = sheet.getRow(rowNumber);
    const headers = Array.from({ length: sheet.columnCount }, (_, index) => toText(headerData.getCell(index + 1).value));
    const name = findColumn(headers, HEADER_NAMES);
    const price = findColumn(headers, HEADER_PRICES);
    if (name < 0 || price < 0) continue;
    headerRow = rowNumber;
    columns = {
      name: name + 1,
      price: price + 1,
      category: findColumn(headers, HEADER_CATEGORIES) + 1,
      description: findColumn(headers, HEADER_DESCRIPTIONS) + 1,
      dietary: findColumn(headers, HEADER_DIETARY) + 1,
    };
    break;
  }
  if (!headerRow) throw new Error("Could not find Name and Price columns. Add a header row with columns such as Category, Name, Price, Description, Dietary Type.");

  const rows: MenuImportRow[] = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const name = toText(row.getCell(columns.name).value);
    const price = parsePrice(row.getCell(columns.price).value);
    if (!name || price === null) continue;
    rows.push(makeRow(
      columns.category > 0 ? toText(row.getCell(columns.category).value) : "Imported Menu",
      name,
      price,
      columns.description > 0 ? toText(row.getCell(columns.description).value) : "",
      columns.dietary > 0 ? toText(row.getCell(columns.dietary).value) : "veg",
    ));
    if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Import up to ${MAX_IMPORT_ROWS} menu items at a time.`);
  }
  return rows;
}

function getPriceFromLine(line: string) {
  const currencyPattern = /(?:₹|INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)/gi;
  let currencyMatch: RegExpExecArray | null;
  let lastCurrencyMatch: RegExpExecArray | null = null;
  while ((currencyMatch = currencyPattern.exec(line))) lastCurrencyMatch = currencyMatch;
  if (lastCurrencyMatch?.index !== undefined) {
    const value = Number(lastCurrencyMatch[1].replace(/,/g, ""));
    return Number.isFinite(value) ? { index: lastCurrencyMatch.index, value } : null;
  }

  const trailingPrice = /(?:^|\s)([\d,]+(?:\.\d{1,2})?)\s*(?:\/\s*-|only)?\s*$/i.exec(line);
  if (!trailingPrice || trailingPrice.index === undefined) return null;
  const value = Number(trailingPrice[1].replace(/,/g, ""));
  return Number.isFinite(value) ? { index: trailingPrice.index, value } : null;
}

function isCategoryHeading(line: string) {
  if (line.length > 55 || /[.!?]$/.test(line)) return false;
  const letters = line.replace(/[^\p{L}]/gu, "");
  if (!letters || ["menu", "foodmenu", "pricelist"].includes(normalizedHeader(line).replace(/\s/g, ""))) return false;
  return line.endsWith(":") || (letters === letters.toLocaleUpperCase("en-US") && letters !== letters.toLocaleLowerCase("en-US"));
}

function explicitDietaryType(value: string): "veg" | "non-veg" | null {
  const words = normalizedHeader(value).split(" ");
  if (words.includes("nv") || (words.includes("non") && (words.includes("veg") || words.includes("vegetarian")))) return "non-veg";
  if (words.includes("veg") || words.includes("vegetarian")) return "veg";
  return null;
}

function rowsFromPdfLines(lines: string[]) {
  const rows: MenuImportRow[] = [];
  let category = "Imported Menu";
  let categoryDietaryType: "veg" | "non-veg" = "veg";
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line || line.length < 2) continue;
    const price = getPriceFromLine(line);
    if (price) {
      const name = line.slice(0, price.index).replace(/[.\s·–—-]+$/g, "").trim();
      if (name.length >= 2) {
        rows.push(makeRow(category, name, price.value, "", explicitDietaryType(line) ?? categoryDietaryType));
        if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Import up to ${MAX_IMPORT_ROWS} menu items at a time.`);
      }
      continue;
    }
    if (isCategoryHeading(line)) {
      category = line.replace(/:$/, "").trim();
      categoryDietaryType = explicitDietaryType(line) ?? "veg";
      continue;
    }
    const previous = rows.at(-1);
    if (previous && line.length <= 240) previous.description = [previous.description, line].filter(Boolean).join(" ").slice(0, 500);
  }
  return rows;
}

async function parsePdf(file: File): Promise<MenuImportRow[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  if (document.numPages > 100) throw new Error("Import PDFs with 100 pages or fewer.");
  const lines: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const grouped = new Map<number, { x: number; text: string }[]>();
    for (const rawItem of content.items) {
      if (!("str" in rawItem) || typeof rawItem.str !== "string" || !("transform" in rawItem) || !Array.isArray(rawItem.transform)) continue;
      const x = Number(rawItem.transform[4]);
      const y = Number(rawItem.transform[5]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !rawItem.str.trim()) continue;
      const lineY = Math.round(y / 2) * 2;
      const items = grouped.get(lineY) ?? [];
      items.push({ x, text: rawItem.str });
      grouped.set(lineY, items);
    }
    const pageLines = [...grouped.entries()].sort(([left], [right]) => right - left)
      .map(([, items]) => items.sort((left, right) => left.x - right.x).map((item) => item.text).join(" ").trim())
      .filter(Boolean);
    lines.push(...pageLines);
  }
  return rowsFromPdfLines(lines);
}

export async function parseMenuImportFile(file: File): Promise<MenuImportRow[]> {
  if (file.size > 15 * 1024 * 1024) throw new Error("Choose an XLSX or PDF file smaller than 15 MB.");
  const extension = file.name.split(".").pop()?.toLocaleLowerCase("en-US");
  const rows = extension === "xlsx" ? await parseXlsx(file) : extension === "pdf" ? await parsePdf(file) : null;
  if (!rows) throw new Error("Choose an .xlsx spreadsheet or a text-based .pdf menu.");
  if (!rows.length) throw new Error("No menu rows were found. Scanned PDFs need OCR; use a text-based PDF or XLSX file instead.");
  return rows;
}
