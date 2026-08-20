import { expect,test } from "@playwright/test";

test("driver PWA is mobile-first and requires real employee authentication",async({page,request})=>{
  await page.setViewportSize({width:390,height:844});
  const response=await page.goto("/employee/deliveries");
  expect(response?.headers()["permissions-policy"]).toContain("camera=(self)");
  expect(response?.headers()["permissions-policy"]).toContain("geolocation=(self)");
  await expect(page.getByRole("heading",{name:"Employee sign in"})).toBeVisible();
  await expect(page.getByLabel("Employee PIN")).toBeVisible();
  expect((await request.get("/api/driver/deliveries")).status()).toBe(401);
});

test("customer tracking rejects random tokens without exposing order data",async({page,request})=>{
  const token="not-a-real-tracking-token";
  const response=await request.get(`/api/customer/tracking/${token}`);
  expect(response.status()).toBe(404);
  expect(await response.json()).toEqual({error:"Tracking link is invalid or expired."});
  await page.goto(`/track/${token}`);
  await expect(page.getByText("Tracking link is invalid or expired.",{exact:true})).toBeVisible();
  await expect(page.getByText(/customer|address|driver/i)).toHaveCount(0);
});
