"use client";

import { canvasToJpegBlob, drawCanvasImage, loadImageFile } from "@/app/client-image";
import { useEffect } from "react";

const ICON_SIZE = 512;
const JPEG_QUALITY = 0.82;



function optimizedName(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, "").trim() || "employee-profile";
  return `${base}-icon.jpg`;
}

async function optimizeProfilePhoto(file: File): Promise<File> {
  if (!file.type.toLowerCase().startsWith("image/")) {
    throw new Error("Choose an image file for the icon.");
  }

  const image = await loadImageFile(file, "This photo could not be opened on the device.");
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
  drawCanvasImage(context, image, { x: sourceX, y: sourceY, width: crop, height: crop }, { x: 0, y: 0, width: ICON_SIZE, height: ICON_SIZE });

  const blob = await canvasToJpegBlob(canvas, JPEG_QUALITY, "This photo could not be resized.");
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
