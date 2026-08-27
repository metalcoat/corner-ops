export {};

declare global {
  interface Window {
    appendHelcimPayIframe?: (
      checkoutToken: string,
      allowExit?: boolean,
    ) => void;
    removeHelcimPayIframe?: () => void;
  }
}
