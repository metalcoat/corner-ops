// Sign-in by hand: opens a supplier's site in the price job's own browser profile
// on the container's screen (shown on the deli network by signin.sh), so a person
// can sign in and pass the site's "I'm not a robot" check themselves. The price
// job then reuses that saved session. Closes by itself once the account pages load.
//
//   supplier-prices-sync.sh --signin webstaurant
import { chromium } from "playwright";

const PROFILES = process.env.PROFILE_DIR || "/profiles";
const MINUTES = Number(process.env.SIGNIN_MINUTES || 15);

// signedIn: a page that loads (200) only when signed in; signed out it redirects to the login.
const SITES = {
  webstaurant: {
    key: "WEBSTAURANT",
    name: "WebstaurantStore",
    login: "https://www.webstaurantstore.com/myaccount/?target_url=%2Fmyaccount%2Forders%2F",
    signedIn: "https://www.webstaurantstore.com/myaccount/orders/",
    email: "#email",
    password: "#password",
  },
};

const site = SITES[(process.argv[2] || "").toLowerCase()];
if (!site) {
  console.error(`Which site? One of: ${Object.keys(SITES).join(", ")}`);
  process.exit(2);
}

const context = await chromium.launchPersistentContext(`${PROFILES}/${site.key}`, {
  headless: false,
  viewport: null,
  args: ["--window-position=0,0", "--window-size=1280,900", "--start-maximized"],
  locale: "en-US",
  timezoneId: "America/New_York",
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});

async function signedIn() {
  const response = await context.request.get(site.signedIn, { maxRedirects: 0, timeout: 20_000 }).catch(() => null);
  return response?.status() === 200;
}

try {
  if (await signedIn()) {
    console.log(`${site.name}: already signed in; nothing to do.`);
  } else {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(site.login, { waitUntil: "domcontentloaded" });
    // Saves typing: the account from .env goes in the boxes. The person still presses Sign in.
    const user = process.env[`${site.key}_USERNAME`], password = process.env[`${site.key}_PASSWORD`];
    try {
      if (user) await page.locator(site.email).first().fill(user, { timeout: 10_000 });
      if (password) await page.locator(site.password).first().fill(password, { timeout: 5_000 });
    } catch {
      // The form moved or looks different; the person can type it in.
    }
    console.log(`${site.name}: waiting up to ${MINUTES} minutes for you to sign in…`);
    const deadline = Date.now() + MINUTES * 60_000;
    let done = false;
    while (!done && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      done = await signedIn();
    }
    if (!done) {
      console.error(`${site.name}: not signed in after ${MINUTES} minutes; closing. Run it again when you're ready.`);
      process.exitCode = 1;
    } else {
      // Let the site finish setting its cookies before the profile is saved.
      await page.goto(site.signedIn, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3_000);
      console.log(`${site.name}: signed in. The price job will use this session from now on.`);
    }
  }
} finally {
  await context.close();
}
