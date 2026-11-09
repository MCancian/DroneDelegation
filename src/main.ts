import './styles.css';

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = text;
  }
}

setText('clock', '00:00 / 15:00');
setText('hull', 'Hull 100%');
setText('autonomy-air', 'Air: HOLD');
setText('autonomy-surface', 'Surface: HOLD');

const canvas = document.getElementById('radar-canvas');

if (canvas instanceof HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');

  if (ctx) {
    const draw = (): void => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const minDim = Math.min(width, height);
      const padding = Math.min(28, Math.max(4, minDim * 0.12));
      const radius = Math.max(1, minDim / 2 - padding);
      const maxNm = 40;
      const rings = [10, 20, 30, 40];
      const fontSize = Math.max(8, Math.min(12, minDim * 0.025));
      const tickLength = Math.max(1, Math.min(8, radius * 0.08));
      const bearingLabelRadius = radius + Math.min(14, Math.max(4, padding * 0.6));

      ctx.font = `${fontSize}px "Courier New", Courier, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      ctx.strokeStyle = 'rgba(0, 255, 102, 0.28)';
      ctx.fillStyle = 'rgba(127, 255, 159, 0.72)';
      ctx.lineWidth = 1;

      for (const nm of rings) {
        const ringRadius = (nm / maxNm) * radius;

        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        const labelAngle = ((45 - 90) * Math.PI) / 180;
        const labelX = cx + ringRadius * Math.cos(labelAngle);
        const labelY = cy + ringRadius * Math.sin(labelAngle);
        ctx.fillText(String(nm), labelX, labelY);
      }

      for (let deg = 0; deg < 360; deg += 10) {
        const angle = ((deg - 90) * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        ctx.beginPath();
        ctx.moveTo(cx + radius * cos, cy + radius * sin);
        ctx.lineTo(cx + (radius - tickLength) * cos, cy + (radius - tickLength) * sin);
        ctx.stroke();

        if (deg % 30 === 0) {
          const labelX = cx + bearingLabelRadius * cos;
          const labelY = cy + bearingLabelRadius * sin;
          ctx.fillText(String(deg).padStart(3, '0'), labelX, labelY);
        }
      }

      const headingDeg = 340;
      const headingAngle = ((headingDeg - 90) * Math.PI) / 180;
      const headingLength = Math.max(4, radius * 0.25);

      ctx.strokeStyle = '#00ff66';
      ctx.fillStyle = '#00ff66';
      ctx.lineWidth = 2;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + headingLength * Math.cos(headingAngle), cy + headingLength * Math.sin(headingAngle));
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
    };

    draw();
    window.addEventListener('resize', draw);
  }
}
