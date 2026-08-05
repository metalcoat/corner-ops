"use client";

import { useEffect } from "react";

const ICON_SIZE = 512;
const JPEG_QUALITY = 0.82;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This photo could not be opened on the device."));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("This photo could not be resized.")),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

function optimizedName(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, "").trim() || "employee-profile";
  return `${base}-icon.jpg`;
}

async function optimizeProfilePhoto(file: File): Promise<File> {
  if (!file.type.toLowerCase().startsWith("image/")) {
    throw new Error("Choose an image file for the icon.");
  }

  const image = await loadImage(file);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("This photo has no usable image dimensions.");

  const crop = Math.min(width, height);
  const sourceX = Math.max(0, (width - crop) / 2);
  const sourceY = Math.max(0, (height - crop) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This browser could not prepare the icon photo.");
  context.fillStyle = "#0f172a";
  context.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, sourceX, sourceY, crop, crop, 0, 0, ICON_SIZE, ICON_SIZE);

  const blob = await canvasBlob(canvas);
  return new File([blob], optimizedName(file), {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
}

function compactSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ProfilePhotoOptimizer() {
  useEffect(() => {
    const activeJobs = new WeakMap<HTMLInputElement, symbol>();

    const handleChange = async (event: Event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
      if (input.name !== "cameraProfilePhoto" && input.name !== "profilePhoto") return;

      const form = input.closest<HTMLFormElement>(".employeeProfilePhotoForm");
      const file = input.files?.[0];
      if (!form || !file) return;

      const job = Symbol("profile-photo-optimization");
      activeJobs.set(input, job);
      form.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((other) => {
        if (other !== input) other.value = "";
      });

      const button = form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
      const originalLabel = button?.textContent || "Update icon";
      if (button) {
        button.disabled = true;
        button.textContent = "Optimizing photo…";
      }
      form.setAttribute("aria-busy", "true");

      try {
        const optimized = await optimizeProfilePhoto(file);
        if (activeJobs.get(input) !== job) return;

        const transfer = new DataTransfer();
        transfer.items.add(optimized);
        input.files = transfer.files;
        if (button) button.textContent = `Ready · ${compactSize(optimized.size)}`;
      } catch (error) {
        if (activeJobs.get(input) !== job) return;
        console.warn("[employee-profile] photo optimization skipped", error);
        if (button) button.textContent = "Use original photo";
      } finally {
        if (activeJobs.get(input) === job) {
          form.removeAttribute("aria-busy");
          if (button) button.disabled = false;
          window.setTimeout(() => {
            if (button && !button.disabled) button.textContent = originalLabel;
          }, 1400);
        }
      }
    };

    document.addEventListener("change", handleChange);
    return () => document.removeEventListener("change", handleChange);
  }, []);

  return null;
}
