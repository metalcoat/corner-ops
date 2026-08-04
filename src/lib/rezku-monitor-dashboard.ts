import { rezkuImportDashboard } from "@/lib/rezku-monitor";

export async function cleanRezkuImportDashboard() {
  const dashboard = await rezkuImportDashboard();
  return {
    ...dashboard,
    imports: dashboard.imports.map((batch) => ({
      ...batch,
      missingClockIn: batch.rowsImported > 0 ? batch.missingClockIn : 0,
      missingClockOut: batch.rowsImported > 0 ? batch.missingClockOut : 0,
    })),
  };
}
