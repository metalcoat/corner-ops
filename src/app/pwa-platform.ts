export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export function isStandalone(): boolean {
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  return iosStandalone || window.matchMedia("(display-mode: standalone)").matches;
}

export function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function applicationServerKey(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

export function deviceLabel() {
  if (/iphone/i.test(navigator.userAgent)) return "iPhone";
  if (/ipad/i.test(navigator.userAgent)) return "iPad";
  if (/android/i.test(navigator.userAgent)) return "Android device";
  if (/windows/i.test(navigator.userAgent)) return "Windows device";
  if (/macintosh/i.test(navigator.userAgent)) return "Mac";
  return "Browser device";
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support installed web apps.");
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return registration;
}
