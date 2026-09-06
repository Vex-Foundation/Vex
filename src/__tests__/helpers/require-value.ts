/** Assert the fixture or observed result exists before inspecting its fields. */
export function requireValue<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error("Expected a defined test value");
  }
  return value;
}
