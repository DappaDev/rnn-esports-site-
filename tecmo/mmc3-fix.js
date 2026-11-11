/*
 * RNN E League – MMC3 accuracy fix for jsnes (mapper 4, used by Tecmo Super Bowl)
 *
 * jsnes's MMC3 differs from the real chip in three ways that scramble Tecmo's graphics:
 *  1. Writing $8000 changes the CHR "A12 inversion" and PRG mode bits, but jsnes only applies
 *     them to banks written afterwards. Real hardware re-maps every bank immediately, using the
 *     values already stored in R0–R7. Tecmo flips these modes without rewriting the banks.
 *  2. The scanline counter registers are swapped: $C000 is the reload LATCH and $C001 RESTARTS
 *     the counter (it reloads from the latch on the next scanline). jsnes did the reverse, so
 *     split-screen effects could land on the wrong line or not repeat.
 *  3. R0/R1 select 2 KB banks: the hardware ignores the low bit of those values.
 *
 * This file patches the MMC3 class in place, so it must load after jsnes-core.min.js and before
 * a ROM is loaded. Everything else in jsnes is unchanged.
 */
(function () {
  "use strict";
  if (!window.jsnes || !jsnes.NES) return;

  // Find the MMC3 class through a throwaway NES instance's mapper table.
  var probe = new jsnes.NES({ onFrame: function () {}, onAudioSample: null, emulateSound: false });
  var MMC3 = null;
  try {
    // jsnes keeps its mapper classes on the ROM object's constructor-time lookup; the simplest
    // stable handle is a tiny fake ROM that asks for mapper 4.
    var hdr = new Uint8Array(16 + 16384 * 2 + 8192);
    hdr.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0x40, 0x00]);
    probe.loadROM(hdr);
    MMC3 = probe.mmap && probe.mmap.constructor;
  } catch (e) { MMC3 = null; }
  if (!MMC3 || MMC3.mapperName !== "MMC3") { console.warn("MMC3 fix: mapper class not found, leaving jsnes as is"); return; }

  var P = MMC3.prototype;
  var baseWrite = Object.getPrototypeOf(P).write;          // the generic mapper's write (RAM, PPU/APU regs)
  var baseToJSON = P.toJSON, baseFromJSON = P.fromJSON, baseReset = P.reset;

  function setup(m) {
    if (m._fix) return;
    m._fix = true;
    m.regs = [0, 2, 4, 5, 6, 7, 0, 1];   // R0–R7, power-on values used by most emulators
    m.irqReload = false;
    m.chrSlots = [-1, -1, -1, -1, -1, -1, -1, -1];  // which 1 KB CHR bank sits at each $0400 slot
    m.prgSlots = [-1, -1, -1, -1];                  // which 8 KB PRG bank sits at $8000/$A000/$C000/$E000
  }

  P.syncChr = function () {
    if (this.nes.rom.vromCount === 0) return;
    var r = this.regs;
    var want = [r[0] & 0xfe, r[0] | 1, r[1] & 0xfe, r[1] | 1, r[2], r[3], r[4], r[5]];
    if (this.chrAddressSelect) want = want.slice(4).concat(want.slice(0, 4)); // A12 inversion swaps halves
    var total = this.nes.rom.vromCount * 4; // 1 KB banks
    for (var s = 0; s < 8; s++) {
      var b = want[s] % total;
      if (this.chrSlots[s] !== b) { this.load1kVromBank(b, s * 1024); this.chrSlots[s] = b; }
    }
  };

  P.syncPrg = function () {
    var total = this.nes.rom.romCount * 2; // 8 KB banks
    var last = total - 1, r6 = this.regs[6] % total, r7 = this.regs[7] % total;
    var want = this.prgAddressSelect ? [last - 1, r7, r6, last] : [r6, r7, last - 1, last];
    for (var s = 0; s < 4; s++) {
      if (this.prgSlots[s] !== want[s]) { this.load8kRomBank(want[s], 0x8000 + s * 0x2000); this.prgSlots[s] = want[s]; }
    }
  };

  P.write = function (address, value) {
    if (address < 0x8000) { baseWrite.call(this, address, value); return; }
    setup(this);
    switch (address & 0xe001) {
      case 0x8000: // bank select + modes: re-map everything that the new modes affect
        this.command = value & 7;
        var prg = (value >> 6) & 1, chr = (value >> 7) & 1;
        var prgChanged = prg !== this.prgAddressSelect, chrChanged = chr !== this.chrAddressSelect;
        this.prgAddressSelect = prg; this.chrAddressSelect = chr;
        if (chrChanged) this.syncChr();
        if (prgChanged) this.syncPrg();
        break;
      case 0x8001: // bank data
        this.regs[this.command] = value;
        if (this.command < 6) this.syncChr(); else this.syncPrg();
        break;
      case 0xa000:
        if (this.nes.rom.getMirroringType && this.nes.rom.getMirroringType() === this.nes.rom.FOURSCREEN_MIRRORING) break;
        this.nes.ppu.setMirroring((value & 1) ? this.nes.rom.HORIZONTAL_MIRRORING : this.nes.rom.VERTICAL_MIRRORING);
        break;
      case 0xa001: break;                                   // PRG-RAM protect: always allow (like most emulators)
      case 0xc000: this.irqLatchValue = value; break;       // reload value
      case 0xc001: this.irqCounter = 0; this.irqReload = true; break; // restart on next scanline
      case 0xe000: this.irqEnable = 0; break;               // disable (and acknowledge)
      case 0xe001: this.irqEnable = 1; break;
    }
  };

  // Called by the PPU once per visible scanline while rendering is on.
  P.clockIrqCounter = function () {
    setup(this);
    if (this.irqCounter === 0 || this.irqReload) { this.irqCounter = this.irqLatchValue; this.irqReload = false; }
    else this.irqCounter--;
    if (this.irqCounter === 0 && this.irqEnable === 1) this.nes.cpu.requestIrq(this.nes.cpu.IRQ_NORMAL);
  };

  var baseLoadROM = P.loadROM;
  P.loadROM = function () {
    setup(this);
    baseLoadROM.call(this);
    // jsnes's loadROM maps the first PRG/CHR banks directly; record that as "unknown" so the
    // first real register writes always map.
    this.chrSlots = [-1, -1, -1, -1, -1, -1, -1, -1];
    this.prgSlots = [0, 1, this.nes.rom.romCount * 2 - 2, this.nes.rom.romCount * 2 - 1];
  };

  if (baseReset) P.reset = function () { baseReset.call(this); this._fix = false; setup(this); };

  // Save states: keep the registers so a loaded state maps the same banks.
  P.toJSON = function () {
    var t = baseToJSON.call(this);
    setup(this);
    t.regs = this.regs.slice(); t.irqReload = this.irqReload;
    return t;
  };
  P.fromJSON = function (t) {
    baseFromJSON.call(this, t);
    setup(this);
    if (t.regs) this.regs = t.regs.slice();
    this.irqReload = !!t.irqReload;
    this.chrSlots = [-1, -1, -1, -1, -1, -1, -1, -1];
    this.prgSlots = [-1, -1, -1, -1];
    // PPU/CPU memory came back from the state already; only re-sync if we know the registers.
    if (t.regs) { this.syncChr(); this.syncPrg(); }
  };

  window.__mmc3Fixed = true;
})();
