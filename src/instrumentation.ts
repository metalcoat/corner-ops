export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertProductionSecurity } = await import("./lib/production-security");
    assertProductionSecurity();
  }
}
