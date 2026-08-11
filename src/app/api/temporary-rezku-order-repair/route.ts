import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import * as XLSX from "xlsx";
import { getSql } from "@/lib/db";
import { downloadRezkuWorkbook } from "@/lib/rezku-workbook-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_SHA256 = "43dbf899e67dc07e47c713168afb59a472ee437a0d232f9167663b2450e1f165";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";
const REPAIR_KEY = "temporary-rezku-history-2026-08-03-v3-direct-xlsx";
const ENCRYPTED_SOURCES: Record<string, string> = {
  "2026-08-03": "D6wC1hn2lRIB9zLHAW7w-M1h0UQlhd3JEdYJRjqXNki4btyNqTsYhXqF4XKj56jZof0j4iSzL_awAwHlXVyTj_c-A2KZl8V_OHxISg9SrW2Iq8x3yj1HbJAZN1yF11RK9XqNRpCAmr_-qOyysk4D9n3XOmLXL06AyEBvu8JYXlvRMJxKnQm7hsBjCoEPTRFnXBah0Q6w96AN1eKFPCnZm7qIfv9D7pvYq9VLG8mfjZcRHzL6kPNcfhWDMFVxBoehXEG4lfeBTbOSwpprr2V-x6isxFIUMyqu0T9EIC7lSXIbOswmhHFJI0qoHP7vtK9Jb0Na7l3QJcWqnI4XxrlhHMs4R1gNAQWLvpxyHerGbYLFxMGWTe_lpNDOASOFBGsM149PZYtD5ScmzdPMOX0wpHprY7SF1KGl198QdrNZeDF1zt60dkWDpLfXQfFA31O5elHj7VsdFsH_x2_jvEk06JHtVzAIpHzzrabVISAHLpKAymdYLg8hulLORIjdSUriVnO9ZfvpH-x75lwsWrrLD0xTdEKNfeUspHptkvtNWm0VWWEjDj5LkncK3Tltagsv8ZcvQSva89NR_Ovesp24wsDSPxvB76ZaeRQ4bNOQ4wJWQEOtakeBwKU8v3B82nhwp6_0RxCx3V9xOOdpqezuXZO76MDYrntNkMcs9IkWzLlXgS1K7hufEr88vzYMmvfubVjRajIjJthcx6UNRCA8kG68wASpSmc_88dK-28YExgHG2zwUWxqMC-5",
  "2026-08-04": "aJlu8Am4sMJoyInvZtk7fE2Sy_AEYH2j4phyhZF1E-xk3FGIYchbfMk8wUsIHYNy9dwjGufiRZj5QLGzo9SsemvaN8s5EkJRic8MjQdaqi2y7BBgaR7jY2a9YGSv3A0nsZC4wFxpkn2ZUFb1pWhZFQ0fw8DQQ84aVJGxgezPcmjarEj_GbF9pxRSr5BsLb1hpqNI9GR3p7V7fudl8a6v1yXWZBRO-GglDnBdDEwd6F20ELeLXQmC7lpr1uhIYxQtE05-BgSWAPX76_raw72hT59Yl6fwILEEuF3zqiU_rlETTMBuK5Gu1k6-bPiHejUAfoh0vub4WqRxeSz84HNDsBpDMwsypKn8Qs7t5khIwdKlq1huPrT1GKTkWzqta3zrGAqrNYhtu0aeE5FY1ARpnE1g-pNsS2gMi2SVQ-JW-QLFjBDkHd97yd5LQbZYwCSLHORzxcX5pas95glOn45lg-c9ffR2ktU1rmd7-h0HjZzwmAQG_tTwSxeBKmb4WSI4QS2qledK5B2fRtqGLza3Ba1qUWZmn-B3jT5DuynaTjlCK_MSiUQXNPo4uvPTQfGd01sNyOyubWusHuXWB51UF50WiUMq54i9rbJ4p8JtXEEy5Wk4TBRQ2Kot3e37bglMS631m4EC4Vj4un3xegkfUWYRW_DUQuqPjRcht4A5eBZZyaS-AXRpMcJm8UB7XBGcolXjBJqQMJ0GwE03QYYn1nl4BYs7DRFZMuIJJJyWle0hJvGGMuzDYXBP",
  "2026-08-05": "lve-j_BFxRJLAJzNbVhRPxaRhgxOwY8OGvIHEw5KlQaWof30PyfrGau0abosvXi2fAfvWavvrSs0lxDay6HZ2LduMUDhXHhEqPaYtJ1H9Tm_7BePBMMyTtqsx9e9b1I7uDq0xU7jDDml5Hl_LrFRsttlSvlZJo8qNdHruLuAZvgP95gvfE75057u2bMCEaW6sbvaENZUMdxb4d9INSgUHUyyPpQA7_Cx1bEUqqffHN6gdznyhc7jlMBdodvCP-Ux3zyLUTNopMeutSf8vu4OzHswy3vNXYKaVNDma8Fdwd51U3lcdqz5ZWRgGYguXA3AnjO75bxf0AcE2t6CTBMk_xfH1kQMVIYfaZKhj53cGeY2n9ENPx4x_ibiqBEnWNzXoTnLbhUZpvbQL7ahLWMot9OLwI_6OFdgz7bCbS_9AyEFEIIj-_58jTqwKLeLFjA3IqoPhtYCi4k9Vrz4QKMo2m0yHXEbueJN_HuCVZ1tSRcm5YZBrUfs8JolwVGiL9pWfxCchSaIitP-ulJDNIKch4AN3W8SEO9pi9G1mn2BA8Lbqb2T8s-Ik3xnCL4fCaEpNOQKR3WylCRK5kaNZEo4nMXVYImd36M--LhOi5JHdw11zp5dPOskiUT7AEC3_quJJvK6TYYQTffOkrEs_WBRIWPWuD4G9Z80rydxYVscIl_69JYsBWrZL33nrcpp_KWYDIqMTyL-cfRP5x8O31HVy7CfP_GHFO25cQ7lCP6YtsyDN4UJD8DcrJVg",
  "2026-08-06": "0d6bNACZSC7sf5BDTI97UxxV_6y-pSHef56egYls5BWltl9M4u3OeN6RUOVLj3daa7xWj6n1YeyT0jGA-ypzeYdUa8h9qwttTsryUXMug0hp3kqpm0w6_lpEhb7TxuczUQgNXnRDJged-qQMoxR4JAnYSBuA5Q7Vae6cMcax7lsRAx-LXlgJhocRdlGflxug0JVhYufq5KxrTihivJYtAyTwThGs0LOGnTsaHwSGMGVQOq7t2w2P3v6xyzniR1vtiQpaqTVpkyHbckuCLQHnuzE78rvB_CyKspPQtfnKIP9otIWneNl_ZlB9kSLybzZ6hJ-p9nL-dLaQPF6pWGHIR0jpBPeShBvpoRU075_z4gpYlIcVpobCXgSdFwzyW5VcIiTK2WzIpu5ZOQOCZLg94aSIiR_A-eA39IsPhr6h6yXtmmSqI8a30yoB_G6g3_Yj5kwuXkT3g0bTBYMWW5Y5Fwx_wJf7UVFjGXMVtIXLqQUyyi3qQerRUvYXRa2rHqmoJNdaaOufYFploFPhPMYr8hf2LxRpQ7gTPLlS4ceoBbMe4LQA8oeU9KorbxTltwldkRulnbmCiHe0xiroEYVdLS07On9I7nPav6BC-KMfmUNXuNQT8Ls283j8Kf4fbSeHNs3HEH7PLSb8OHCGQz5d6yLmiMpJfZuadSqFfjX25Zn6JN9MxoT6jk2ImC8Xhst5B8F2RyZpBtLxUArj-v60_GJmQiZ_Pf1y4HDzkVp_GyQnBVO6o7ZZS07y",
  "2026-08-07": "2ee9_bCA-tOWBywu-1EAqU2myRleBWE_Tw0NFOwLy_aHbjUySMJ253ErAaUmo5dT2I7nohrUSHbxZKKn7nxlrZktoWlDO-vbp0iJfzOtF7ogOZciFRR7R6VDBSxTcmGWRdb-8ynFyliiQZXZUDEjK1S6VUG5QIjZLBiEqpoN263vS47RBziC-1pSfwKHqyp_4VuAS_H2mwjdbaHcV-Ck8k_g7Og268pjjtgaRSKdx4oIlJP5xqMrzwL4hTigziNFU3TaXAdNuYDgKkKuBKXNC_tYWsS5uHxfOyevP5PZV20nFIk5w9HxjQh3gGDt0rmMItNImCa6VRQIDjKSAsFv6AL3dwAURCqSiFXN6JUEiBpN533epwO1rUGTVzbEpEFhPZpzKp-gxscSeEa1_OdkBzJe0sA60STV3EC7VeV6KTD_5b56wxW-ir35FTlk-SxVL6Sn2LLKQr6t_IUygUtwaceLQ-x_5x1mbuOwK878zpjGTACYiO_580h0i1tMDO0sMr4JoMSqFtdyOELFXX_szzmfNliW7m5cOvsygYL6IjonUaHQuCNrawx2tm82kMifertdp1QUO8A1Hz8rcAzhf3z3ZAhb85NfBhCLu766yxFX_IdyzOGRmm2eR222qF9gGRhn9wQbg05dw6hb-cIjxsQEJNq1LspW0Vl-WtH44DV7bO9OOLcbAo1OlNu16gYJz5Jgb1v5iXqVSSjQt8fpdqqI0LCK6vgPj3DJ0b-o62mvMeASnH9NHo9w",
  "2026-08-08": "LOwaKENXN_K7tcRbgkP3St9owGocfe4Bj1qTqZj8pyVUqbB74xdN0-Ggj-1otI2fCVBakvMXl-qJPTz8nhJ3iTIZsrmKiUi1Na8oQyIeKCViHIrs0yN3-aMzYstgd9ubPBjnsCm0F7E13cMJJBfoAPC1DtR06aRve7RGq3Sz-mtDsV3AyX82v4ieo1bvtnT29zZ-Dcv9KAn7bIhT9SEh-SDts6DFXEWY22PDlt5J-bBXuP2hbfe6X2gP9_XAierSgd64vQI8juc8Uqxlgk6gUXx52o14bJUehYG7Ea-MD5Pxb6vc1t9j1PaLzYfmbZJKDnF8FOWQ92liCdG-uBX_jVCqT59SOUNBDQiB8dbCDF4jKfIT4np-Hwn-P4TklZUGrt_r6gaN_F_yc84S4Ig-VzzYYTOo79-Y8TSD14TIRZoPuBnurgrc9f_BKlpNetia-aixSruHPzfIWJWFHr5rLXoy4o-uG8HMgSwybMAfkp1mDXPfLSJUFMn3H_dQ6-lqe1qfryfQsyvr8_EbipNU30sGO46ckZvtWKIys2mekLihE-q0UfrJDsF2a3jXpPzwou8JIkC3RNMO4IL3NEo-H7dQrNjPw5SDwQascs1Gm2OdLzmrx96-Wgdh4RE9Ch3UxhLCSRx2kGKPX0WRXDibbMYn79Vm4kflxLQlQiB45Eed2F2HMaC6LHuI4HdQw9InpY6cVdQz_LMa5jjuuKjBsWwJ70raPm30dlPBQlWFZIrx3E3xu7w8afiw",
  "2026-08-09": "b9gkooWZDb6ARAeGRNK4jGkfamFwlBIMjk_isNpBFyGVFnO0tQKSP7RprdFyD_OpjOgvK7MsETC-UHEmiaPESbySewJDJr1_Na58bZCJQDIPrIUL0EPlmz8rnPW8HFR9J_o9dDxK4BgWN2R9Aek9PNlg1_iDW9z3cGbsGbWws1uDyCpn-noD4aCjLeI2VYjhtFRhsvw5ZSmJen-kNu4kIZTON5zuaxVK9LuTWUwHsvBhv6D80kd07sTxG1vas0VIuCUOwF50CsNmaBnlsqN36bV5sFl5yEE9cUnnNX_ksXmC9W8zRb66CdBa1ZSmMeErnZBT9i0vGCsDS7obioWIqnCNc2Ln7XmHCihZmvNpi4JNGGzef_OZX3tZuTJs_gRUsjTnxUhgIgIjhd6B4hhz8bPqUwKX2y0KuH8ks0iBsreKrJyYyKJUHl16yQ026XzpqvYAIRKdOM5caKv8zICXBHpfmK2E2KV79AVCOfPQSRGTjNKulrYdIJIRRXcLQAzR1ZKqKsS7ibXIRrt3rG8_BreSi5XVD_tiPB5zQgSObyBmTLG3MxqetkpPjWZXzHKK2AddAR2AsVoMSB7bF0Uvkpdsmb_KGV2L8wveUXYxP66ziAgODQS6K9KGedQOM6GF67PYURcHW9sXJg11j3Ro2ryQeJyLu6JCriYM4BW5D1NK5RuLWT3yZmvkKQUXtP6nSrCP49Tc9K92lKnL6R0kUtqANvV9BUM0dzqw5b0hAtfgP4JD5v3udbf1"
};

function authorized(value: string) {
  const supplied = createHash("sha256").update(value).digest();
  const expected = Buffer.from(TOKEN_SHA256, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function decryptSource(day: string, token: string) {
  const encoded = ENCRYPTED_SOURCES[day];
  if (!encoded) throw new Error("Unknown repair day.");
  const payload = Buffer.from(encoded, "base64url");
  if (payload.length <= 28) throw new Error("Invalid encrypted source.");
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(12, payload.length - 16);
  const key = createHash("sha256").update(token).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function trustedOrderExport(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== REZKU_FILE_HOST || !/\/order-export\.xlsx$/i.test(url.pathname)) {
    throw new Error("Only a trusted Rezku Order Export Excel URL is allowed.");
  }
  return url.toString();
}

type TimeParts = { hour: number; minute: number; second: number };
type ParsedWorkbookOrder = {
  orderNorm: string;
  sourceOrderId: string;
  openedAt: Date;
  openHeader: string;
  rawOpenValue: unknown;
  formattedOpenValue: unknown;
  formattedRow: Record<string, unknown>;
  sheetName: string;
  rowNumber: number;
};

function normalizeValue(value: unknown) {
  return String(value ?? "").trim().replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function safeJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return null;
  return value;
}

function clockFromValue(raw: unknown, formatted: unknown): TimeParts | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return { hour: raw.getUTCHours(), minute: raw.getUTCMinutes(), second: raw.getUTCSeconds() };
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const fraction = ((raw % 1) + 1) % 1;
    const totalSeconds = Math.round(fraction * 86400) % 86400;
    return {
      hour: Math.floor(totalSeconds / 3600),
      minute: Math.floor((totalSeconds % 3600) / 60),
      second: totalSeconds % 60,
    };
  }
  for (const value of [formatted, raw]) {
    const text = String(value ?? "").trim();
    const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) continue;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    const meridiem = String(match[4] || "").toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59 && second <= 59) return { hour, minute, second };
  }
  return null;
}

function openHeaderScore(value: string) {
  const key = normalizeValue(value);
  if (key === "orderopenedat") return 0;
  if (key === "orderopened") return 1;
  if (key.includes("orderopenedat")) return 2;
  if (key.includes("openedat")) return 3;
  if (key.includes("orderopen")) return 4;
  if (key.includes("opened")) return 5;
  if (key.includes("opentime")) return 6;
  return 99;
}

function headerRowScore(row: unknown[]) {
  const values = row.map((value) => String(value ?? "").trim()).filter(Boolean);
  let score = Math.min(values.length, 40);
  for (const value of values) {
    const key = normalizeValue(value);
    if (key.includes("order")) score += 20;
    if (key.includes("open")) score += 30;
    if (key.includes("date")) score += 10;
    if (key.includes("type")) score += 5;
    if (key === "id" || key.includes("orderid")) score += 40;
  }
  return score;
}

function parseWorkbookOrders(bytes: ArrayBuffer, day: string, existingOrders: Map<string, string>) {
  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true, cellNF: true });
  const parsed = new Map<string, ParsedWorkbookOrder>();
  const unresolved: Array<Record<string, unknown>> = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
    const formattedRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    if (!formattedRows.length) continue;

    let headerIndex = 0;
    let bestScore = -1;
    for (let index = 0; index < Math.min(formattedRows.length, 25); index += 1) {
      const score = headerRowScore(formattedRows[index] || []);
      if (score > bestScore) {
        bestScore = score;
        headerIndex = index;
      }
    }

    const headers = (formattedRows[headerIndex] || []).map((value, index) => String(value || `Column ${XLSX.utils.encode_col(index)}`).trim());
    const openColumns = headers
      .map((header, index) => ({ header, index, score: openHeaderScore(header) }))
      .filter((item) => item.score < 99)
      .sort((left, right) => left.score - right.score || left.index - right.index);

    for (let rowIndex = headerIndex + 1; rowIndex < rawRows.length; rowIndex += 1) {
      const rawRow = rawRows[rowIndex] || [];
      const formattedRow = formattedRows[rowIndex] || [];
      let orderNorm = "";
      for (const value of [...formattedRow, ...rawRow]) {
        const candidate = normalizeValue(value);
        if (candidate && existingOrders.has(candidate)) {
          orderNorm = candidate;
          break;
        }
      }
      if (!orderNorm) continue;

      let selected: { header: string; index: number; clock: TimeParts } | null = null;
      for (const column of openColumns) {
        const clock = clockFromValue(rawRow[column.index], formattedRow[column.index]);
        if (clock) {
          selected = { header: column.header, index: column.index, clock };
          break;
        }
      }
      if (!selected) {
        unresolved.push({
          day,
          sheetName,
          rowNumber: rowIndex + 1,
          orderId: existingOrders.get(orderNorm),
          openHeaders: openColumns.map((item) => item.header),
        });
        continue;
      }

      const pad = (value: number) => String(value).padStart(2, "0");
      const openedAt = new Date(`${day}T${pad(selected.clock.hour)}:${pad(selected.clock.minute)}:${pad(selected.clock.second)}-04:00`);
      if (Number.isNaN(openedAt.getTime())) continue;

      const formattedObject: Record<string, unknown> = {};
      const width = Math.max(headers.length, formattedRow.length);
      for (let column = 0; column < width; column += 1) {
        const header = headers[column] || `Column ${XLSX.utils.encode_col(column)}`;
        formattedObject[header] = safeJsonValue(formattedRow[column]);
      }

      parsed.set(orderNorm, {
        orderNorm,
        sourceOrderId: existingOrders.get(orderNorm) || orderNorm,
        openedAt,
        openHeader: selected.header,
        rawOpenValue: safeJsonValue(rawRow[selected.index]),
        formattedOpenValue: safeJsonValue(formattedRow[selected.index]),
        formattedRow: formattedObject,
        sheetName,
        rowNumber: rowIndex + 1,
      });
    }
  }

  return { parsed: [...parsed.values()], unresolved };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!authorized(token)) return Response.json({ error: "Unauthorized." }, { status: 401 });
    if (url.searchParams.get("week") !== "2026-08-03") throw new Error("Unknown repair week.");

    const sql = getSql();
    const existingRows = await sql`
      SELECT DISTINCT order_id
      FROM rezku_orders
      WHERE order_id IS NOT NULL AND BTRIM(order_id) <> ''
    ` as unknown as Array<{ order_id: string }>;
    const existingOrders = new Map<string, string>();
    for (const row of existingRows) {
      const key = normalizeValue(row.order_id);
      if (key) existingOrders.set(key, row.order_id);
    }

    let workbookMatches = 0;
    let databaseRowsUpdated = 0;
    const reports: Array<Record<string, unknown>> = [];
    const unresolved: Array<Record<string, unknown>> = [];
    let testWorkbook: Record<string, unknown> | null = null;

    for (const day of Object.keys(ENCRYPTED_SOURCES).sort()) {
      const sourceUrl = trustedOrderExport(decryptSource(day, token));
      const download = await downloadRezkuWorkbook(sourceUrl, `order-export-${day}.xlsx`);
      const parsed = parseWorkbookOrders(download.bytes, day, existingOrders);
      let dayUpdated = 0;

      for (const order of parsed.parsed) {
        const sourceJson = JSON.stringify({
          ...order.formattedRow,
          __historicalWorkbookRepairV3: true,
          __historicalWorkbookSourceDay: day,
          __historicalWorkbookOpenHeader: order.openHeader,
          __historicalWorkbookRawOpenValue: order.rawOpenValue,
        });
        const updated = await sql`
          UPDATE rezku_orders
          SET opened_at = ${order.openedAt.toISOString()},
              raw = COALESCE(raw, '{}'::jsonb) || ${sourceJson}::jsonb
          WHERE REGEXP_REPLACE(LOWER(order_id), '[^a-z0-9]', '', 'g') = ${order.orderNorm}
          RETURNING id
        `;
        dayUpdated += updated.length;
        databaseRowsUpdated += updated.length;
        workbookMatches += 1;

        if (order.orderNorm === "bpc006t6") {
          testWorkbook = {
            day,
            sourceOrderId: order.sourceOrderId,
            sheetName: order.sheetName,
            rowNumber: order.rowNumber,
            openHeader: order.openHeader,
            rawOpenValue: order.rawOpenValue,
            formattedOpenValue: order.formattedOpenValue,
            parsedOpenedAt: order.openedAt.toISOString(),
          };
        }
      }

      unresolved.push(...parsed.unresolved);
      reports.push({
        day,
        downloadMethod: download.method,
        workbookOrdersMatched: parsed.parsed.length,
        databaseRowsUpdated: dayUpdated,
        unresolved: parsed.unresolved.length,
      });
    }

    await sql`
      CREATE TABLE IF NOT EXISTS rezku_data_migrations (
        migration_key TEXT PRIMARY KEY,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`
      INSERT INTO rezku_data_migrations (migration_key) VALUES (${REPAIR_KEY})
      ON CONFLICT (migration_key) DO UPDATE SET completed_at = NOW()
    `;

    const testRows = await sql`
      SELECT order_id, opened_at, order_type,
        raw->>'__historicalWorkbookOpenHeader' AS source_open_header,
        raw->>'__historicalWorkbookRawOpenValue' AS source_raw_open_value,
        raw->>'Order Opened At' AS order_opened_at,
        raw->>'Opened At' AS opened_at_raw
      FROM rezku_orders
      WHERE REGEXP_REPLACE(LOWER(order_id), '[^a-z0-9]', '', 'g') = 'bpc006t6'
      ORDER BY opened_at DESC NULLS LAST
      LIMIT 20
    `;

    return Response.json({
      repaired: true,
      version: 3,
      week: "2026-08-03",
      workbookMatches,
      databaseRowsUpdated,
      reports,
      unresolvedCount: unresolved.length,
      unresolved: unresolved.slice(0, 50),
      testWorkbook,
      testOrder: testRows,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
