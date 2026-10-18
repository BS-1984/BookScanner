// Kamera + Barcode-Erkennung über die native BarcodeDetector-API (Chrome auf Android).

export function isSupported() {
  return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
}

export class Scanner {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.detector = null;
    this.running = false;
    this.torchOn = false;
  }

  async start(onCode) {
    if (this.running) return;
    if (!this.detector) {
      const formats = await BarcodeDetector.getSupportedFormats();
      const wanted = ['ean_13', 'ean_8', 'upc_a', 'code_128'].filter(f => formats.includes(f));
      this.detector = new BarcodeDetector({ formats: wanted.length ? wanted : undefined });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        focusMode: { ideal: 'continuous' },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.loop(onCode);
  }

  async loop(onCode) {
    while (this.running) {
      if (this.video.readyState >= 2) {
        try {
          const codes = await this.detector.detect(this.video);
          for (const c of codes) onCode(c.rawValue, c.format);
        } catch { /* einzelne Frames dürfen fehlschlagen */ }
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }

  stop() {
    this.running = false;
    this.torchOn = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get track() {
    return this.stream?.getVideoTracks()[0] || null;
  }

  hasTorch() {
    const caps = this.track?.getCapabilities?.();
    return !!caps?.torch;
  }

  async toggleTorch() {
    if (!this.hasTorch()) return false;
    this.torchOn = !this.torchOn;
    await this.track.applyConstraints({ advanced: [{ torch: this.torchOn }] });
    return this.torchOn;
  }
}
