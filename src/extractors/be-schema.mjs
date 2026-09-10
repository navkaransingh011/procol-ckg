// PER-BLOB extractor: the database tables. Free and exact -- schema.rb is a plain list.
export const NAME = "be-schema";
export const VERSION = "1.0";

export function handles(p) {
  return p === "db/schema.rb";
}

export function extract(buf) {
  const src = buf.toString("utf8");
  const tables = [];
  const re = /^\s*create_table\s+"([^"]+)"/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    tables.push({ name: m[1], line: src.slice(0, m.index).split("\n").length });
  }
  const version = src.match(/define\(version:\s*([\d_.]+)\)/)?.[1] ?? null;
  return { schema: 1, tables, schemaVersion: version };
}

export function resolve(facts, file) {
  const entities = (facts?.tables ?? []).map((t) => ({
    fqn: `be:table:${t.name}`, kind: "DB_TABLE", name: t.name,
    path: "db/schema.rb", blobSha: file.blobSha, startLine: t.line, endLine: t.line,
    attrs: { table: t.name }, status: "OBSERVED",
    extractor: `${NAME}@${VERSION}`, confidence: 1.0, resolution: "EXACT",
  }));
  return { entities, edges: [] };
}
