function parseDelimited(text, delimiter) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      record.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(field);
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }

  record.push(field);
  if (record.some((value) => value.trim())) records.push(record);
  if (quoted) throw new Error("В CSV-файле не закрыта кавычка.");
  return records;
}

export function parseCSV(text) {
  const contents = text.replace(/^\uFEFF/, "");
  const candidates = [";", ",", "\t"].map((delimiter) => parseDelimited(contents, delimiter));
  return candidates.reduce((best, current) => (current[0]?.length > (best[0]?.length || 0) ? current : best), []);
}

export function serializeCSV(columns, rows) {
  const quote = (value) => {
    let text = String(value ?? "");
    if (/^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return `\uFEFF${[
    columns.map((column) => quote(column.label)).join(";"),
    ...rows.map((row) => columns.map(({ key }) => quote(row[key] || "")).join(";")),
  ].join("\r\n")}`;
}
