import type { CthApi } from './index';
import type { HuddleApi } from './huddle';

declare global {
  interface Window {
    cth: CthApi;
    /** Only present in the Huddle window (see src/preload/huddle.ts). */
    huddle: HuddleApi;
  }
}

export {};
