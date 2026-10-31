declare module 'pannellum';

interface PannellumViewer {
  destroy(): void;
  on(type: string, listener: (event: unknown) => void): PannellumViewer;
}

interface PannellumStatic {
  viewer(container: HTMLElement | string, config: Record<string, unknown>): PannellumViewer;
}

interface Window {
  pannellum?: PannellumStatic;
}
