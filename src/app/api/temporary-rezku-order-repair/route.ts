import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import { importSafeRezkuReport } from "@/lib/safe-rezku-import";
import { downloadRezkuWorkbook } from "@/lib/rezku-workbook-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_SHA256 = "43dbf899e67dc07e47c713168afb59a472ee437a0d232f9167663b2450e1f165";
const REZKU_FILE_HOST = "files.reporting.rezkupos.com";
const REPAIR_KEY = "temporary-rezku-history-2026-08-03";
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

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!authorized(token)) return Response.json({ error: "Unauthorized." }, { status: 401 });
    if (url.searchParams.get("week") !== "2026-08-03") throw new Error("Unknown repair week.");

    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS rezku_data_migrations (
        migration_key TEXT PRIMARY KEY,
        completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const completed = await sql`
      SELECT completed_at FROM rezku_data_migrations WHERE migration_key = ${REPAIR_KEY} LIMIT 1
    ` as unknown as Array<{ completed_at: string }>;
    if (completed[0]) {
      return Response.json({ repaired: true, alreadyCompleted: true, completedAt: completed[0].completed_at });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const day of Object.keys(ENCRYPTED_SOURCES).sort()) {
      const sourceUrl = trustedOrderExport(decryptSource(day, token));
      const download = await downloadRezkuWorkbook(sourceUrl, `order-export-${day}.xlsx`);
      const result = await importSafeRezkuReport(
        `order-export-${day}.xlsx`,
        download.bytes,
        "orders",
        "temporary-payroll-history-repair",
      );
      results.push({
        day,
        batchId: result.batchId,
        rowsRead: result.rowsRead,
        imported: result.imported,
        reportType: result.reportType,
        downloadMethod: download.method,
      });
    }

    await sql`
      INSERT INTO rezku_data_migrations (migration_key) VALUES (${REPAIR_KEY})
      ON CONFLICT (migration_key) DO NOTHING
    `;
    const testRows = await sql`
      SELECT order_id, opened_at, order_type,
        COALESCE(raw->>'Opened At', raw->>'Open Time', raw->>'Order Time', raw->>'Created At', raw->>'Time', '') AS raw_opened_at
      FROM rezku_orders
      WHERE REGEXP_REPLACE(LOWER(order_id), '[^a-z0-9]', '', 'g') = 'bpc006t6'
      ORDER BY opened_at DESC NULLS LAST
      LIMIT 10
    `;

    return Response.json({ repaired: true, week: "2026-08-03", reports: results, testOrder: testRows });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
