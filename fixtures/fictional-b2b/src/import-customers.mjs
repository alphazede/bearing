const headers = "id,name,plan";

export function importCustomers(current, csv, { dryRun }) {
  const lines = csv.trim().split("\n");
  if (lines.shift() !== headers) throw new TypeError("expected id,name,plan CSV header");

  const accepted = [];
  const duplicates = [];
  const seen = new Set(current.map(({ id }) => id));
  for (const line of lines) {
    const [id, name, plan, extra] = line.split(",").map((value) => value?.trim());
    if (!id || !name || !plan || extra !== undefined) throw new TypeError("malformed customer row");
    if (seen.has(id)) {
      duplicates.push(id);
      continue;
    }
    seen.add(id);
    accepted.push({ id, name, plan });
  }

  return {
    committed: !dryRun,
    customers: dryRun ? current : [...current, ...accepted],
    duplicates,
    audit: accepted.map(({ id }) => ({ id, action: dryRun ? "planned" : "imported" })),
    ui: {
      headline: dryRun ? `${accepted.length} customers ready` : `${accepted.length} customers imported`,
      imported: accepted.length,
      duplicates: duplicates.length,
    },
  };
}
