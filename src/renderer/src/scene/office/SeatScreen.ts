import { Container, Graphics } from 'pixi.js';
import type { WorldSeat } from './themeRegistry';

// The painted world's answer to DeskScreen: each seat records where its screen
// is (a monitor, an open laptop, or — for seats that face the viewer — the back
// of a laptop lid). While the seat's owner is sitting there the screen lights
// up: a blue desktop with scrolling output lines, or a glowing logo on the lid.
export class SeatScreen {
  readonly container = new Container();
  private g = new Graphics();
  private on = false;
  private t = 0;
  private w: number;
  private h: number;
  private lid: boolean;

  constructor(seat: WorldSeat) {
    const s = seat.screen!;
    this.w = s.w; this.h = s.h;
    this.lid = seat.kind === 'lid';
    this.container.addChild(this.g);
    this.container.position.set(s.x, s.y);
    // A lid sits on a y-sorted laptop piece, so it must sort above it; a
    // forward-facing screen sits on the backdrop and only needs to beat that.
    this.container.zIndex = this.lid ? s.y + 60 : s.y + s.h;
    this.container.visible = false;
    this.container.eventMode = 'none';
  }

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.container.visible = on;
    if (!on) { this.g.clear(); this.t = 0; }
  }

  update(dt: number): void {
    if (!this.on) return;
    this.t += dt;
    const g = this.g;
    g.clear();
    if (this.lid) {
      const a = 0.75 + 0.25 * Math.sin(this.t * 2.4);
      g.rect(-2, -2, this.w + 4, this.h + 4).fill({ color: 0xbfe3ff, alpha: 0.22 * a });
      g.rect(0, 0, this.w, this.h).fill({ color: 0xffffff, alpha: a });
      return;
    }
    g.rect(0, 0, this.w, this.h).fill(0x3f7fd6);
    g.rect(0, 0, this.w, 1).fill({ color: 0x9cc8ff, alpha: 0.9 });
    for (let i = 0; i < 2; i++) {
      const phase = (this.t * 3.2 + i * (this.h / 2)) % this.h;
      const y = this.h - 1 - phase;
      const lw = Math.min(this.w - 3, 4 + ((i * 5 + Math.floor(this.t / 1.7)) % 6));
      g.rect(2, Math.round(y), lw, 1).fill({ color: 0xdff0ff, alpha: 0.8 });
    }
    if (Math.floor(this.t / 0.53) % 2 === 0) {
      g.rect(2, this.h - 2, 2, 1).fill({ color: 0xffffff, alpha: 0.95 });
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
