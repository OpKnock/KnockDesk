export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const clone = structuredClone(obj);
  const parts = path.split(".");
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    // Prototype-pollution guard (CodeQL js/prototype-pollution-utility):
    // never walk or create __proto__/constructor/prototype links.
    if (parts[i] === "__proto__" || parts[i] === "constructor" || parts[i] === "prototype") {
      return clone;
    }
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    return clone;
  }
  cur[parts[parts.length - 1]] = value;
  return clone;
}
