from pathlib import Path

path = Path('src/app/employee/messages-dock.tsx')
text = path.read_text()

old = '''function selectedPhoto(form: FormData): File | null {
  const camera = form.get("cameraPhoto");
  if (camera instanceof File && camera.size > 0) return camera;
  const library = form.get("photo");
  return library instanceof File && library.size > 0 ? library : null;
}
'''
new = '''const SAFE_FUNCTION_UPLOAD_BYTES = 3.5 * 1024 * 1024;
const MESSAGE_IMAGE_MAX_DIMENSION = 1920;

function selectedPhoto(form: FormData): File | null {
  const camera = form.get("cameraPhoto");
  if (camera instanceof File && camera.size > 0) return camera;
  const library = form.get("photo");
  return library instanceof File && library.size > 0 ? library : null;
}

function selectedProfilePhoto(form: FormData): File | null {
  const camera = form.get("cameraProfilePhoto");
  if (camera instanceof File && camera.size > 0) return camera;
  const library = form.get("profilePhoto");
  return library instanceof File && library.size > 0 ? library : null;
}

function jpegName(fileName: string): string {
  const base = fileName.replace(/\\.[^.]+$/, "").trim() || "photo";
  return `${base}.jpg`;
}

async function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This photo could not be prepared for upload."));
    }, "image/jpeg", quality);
  });
}

async function prepareImageUpload(file: File): Promise<File> {
  if (file.size <= SAFE_FUNCTION_UPLOAD_BYTES) return file;
  if (!file.type.toLowerCase().startsWith("image/")) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    if (!longest) throw new Error("This photo could not be read.");

    for (const maxDimension of [MESSAGE_IMAGE_MAX_DIMENSION, 1600, 1280]) {
      const scale = Math.min(1, maxDimension / longest);
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("This browser could not prepare the photo.");
      context.drawImage(image, 0, 0, width, height);

      for (const quality of [0.84, 0.74, 0.64, 0.54]) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= SAFE_FUNCTION_UPLOAD_BYTES) {
          return new File([blob], jpegName(file.name), {
            type: "image/jpeg",
            lastModified: Date.now(),
          });
        }
      }
    }
  } catch (error) {
    if (file.size <= SAFE_FUNCTION_UPLOAD_BYTES) return file;
    throw new Error(error instanceof Error
      ? `${error.message} Choose a smaller photo and try again.`
      : "Choose a smaller photo and try again.");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  throw new Error("The photo is still too large after resizing. Choose a smaller photo and try again.");
}
'''
if old not in text:
    raise SystemExit('selectedPhoto block not found')
text = text.replace(old, new, 1)

old = '''    const body = String(form.get("body") || "").trim();
    const photo = selectedPhoto(form);
    if (!body && !photo) {'''
new = '''    const body = String(form.get("body") || "").trim();
    let photo = selectedPhoto(form);
    if (!body && !photo) {'''
if old not in text:
    raise SystemExit('send message photo declaration not found')
text = text.replace(old, new, 1)

old = '''    setNotice("");
    try {
      const response = await fetch("/api/employee", { method: "POST", body: form });'''
new = '''    setNotice("");
    try {
      if (photo) {
        const prepared = await prepareImageUpload(photo);
        const camera = form.get("cameraPhoto");
        if (camera instanceof File && camera.size > 0) form.set("cameraPhoto", prepared);
        else form.set("photo", prepared);
        photo = prepared;
      }
      const response = await fetch("/api/employee", { method: "POST", body: form });'''
if old not in text:
    raise SystemExit('send message fetch block not found')
text = text.replace(old, new, 1)

old = '''    const form = new FormData(formElement);
    form.set("action", "profile-photo");
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/employee", { method: "POST", body: form });'''
new = '''    const form = new FormData(formElement);
    form.set("action", "profile-photo");
    const profilePhoto = selectedProfilePhoto(form);
    setBusy(true);
    setNotice("");
    try {
      if (profilePhoto) {
        const prepared = await prepareImageUpload(profilePhoto);
        const camera = form.get("cameraProfilePhoto");
        if (camera instanceof File && camera.size > 0) form.set("cameraProfilePhoto", prepared);
        else form.set("profilePhoto", prepared);
      }
      const response = await fetch("/api/employee", { method: "POST", body: form });'''
if old not in text:
    raise SystemExit('profile photo upload block not found')
text = text.replace(old, new, 1)
path.write_text(text)

route = Path('src/app/api/employee/route.ts')
text = route.read_text()
text = text.replace('const MAX_MESSAGE_PHOTO = 12 * 1024 * 1024;\nconst MAX_PROFILE_PHOTO = 8 * 1024 * 1024;', 'const MAX_MESSAGE_PHOTO = 4 * 1024 * 1024;\nconst MAX_PROFILE_PHOTO = 4 * 1024 * 1024;')
text = text.replace('Message photos are limited to 12 MB.', 'Message photos are limited to 4 MB after resizing.')
text = text.replace('Profile photos are limited to 8 MB.', 'Profile photos are limited to 4 MB after resizing.')
route.write_text(text)
