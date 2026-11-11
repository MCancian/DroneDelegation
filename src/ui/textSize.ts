export const TEXT_SIZES = {
  compact: { label: 'Compact', body: 14, secondary: 12, heading: 16, radar: 12 },
  standard: { label: 'Standard', body: 16, secondary: 14, heading: 18, radar: 14 },
  large: { label: 'Large', body: 18, secondary: 16, heading: 20, radar: 16 },
} as const;

export type TextSize = keyof typeof TEXT_SIZES;
export const TEXT_SIZE_KEY = 'drone-delegation.text-size';

export function readTextSize(storage: Pick<Storage, 'getItem'>): TextSize {
  try {
    const value = storage.getItem(TEXT_SIZE_KEY);
    if (value && Object.hasOwn(TEXT_SIZES, value)) return value as TextSize;
  } catch { /* The display remains usable when browser storage is unavailable. */ }
  return 'standard';
}

export function saveTextSize(storage: Pick<Storage, 'setItem'>, size: TextSize): void {
  try { storage.setItem(TEXT_SIZE_KEY, size); } catch { /* Apply for this watch even without persistence. */ }
}

export function createTextSizeControl(container: HTMLElement): { radarFontSize(): number } {
  let storage: Storage | undefined;
  try { storage = window.localStorage; } catch { /* Storage access itself may be denied. */ }
  let size: TextSize = storage ? readTextSize(storage) : 'standard';
  const root = document.documentElement;
  const apply = (): void => {
    const metrics = TEXT_SIZES[size];
    root.style.setProperty('--text-body-size', `${metrics.body / 16}rem`);
    root.style.setProperty('--text-secondary-size', `${metrics.secondary / 16}rem`);
    root.style.setProperty('--text-heading-size', `${metrics.heading / 16}rem`);
  };
  apply();

  const label = document.createElement('label');
  label.className = 'text-size-control';
  label.append('Text ');
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Text size');
  for (const [value, metrics] of Object.entries(TEXT_SIZES)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = metrics.label;
    select.appendChild(option);
  }
  select.value = size;
  select.addEventListener('change', () => {
    const value = select.value;
    if (!Object.hasOwn(TEXT_SIZES, value)) return;
    size = value as TextSize;
    apply();
    if (storage) saveTextSize(storage, size);
  });
  label.appendChild(select);
  container.appendChild(label);
  return {
    radarFontSize: () => TEXT_SIZES[size].radar * (parseFloat(getComputedStyle(root).fontSize) / 16),
  };
}
