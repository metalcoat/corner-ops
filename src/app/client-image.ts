"use client";

export type CanvasRect = { x: number; y: number; width: number; height: number };

export function drawCanvasImage(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sourceRect: CanvasRect | null,
  destination: CanvasRect,
): void {
  if (sourceRect) {
    context.drawImage(
      source,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      destination.x,
      destination.y,
      destination.width,
      destination.height,
    );
    return;
  }
  context.drawImage(source, destination.x, destination.y, destination.width, destination.height);
}

export function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
  errorMessage = "This image could not be prepared.",
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(errorMessage)), "image/jpeg", quality);
  });
}

export function loadImageFile(file: File, errorMessage = "This image could not be opened."): Promise<HTMLImageElement> {
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
      reject(new Error(errorMessage));
    };
    image.src = url;
  });
}
