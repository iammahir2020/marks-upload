import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import QrCode from './QrCode';

describe('QrCode', () => {
  it('renders an accessible svg naming the encoded url', () => {
    const { container } = render(<QrCode url="https://example.com" />);
    const svg = container.querySelector('svg[role="img"]');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-label')).toBe('QR code linking to https://example.com');
  });

  it('draws a light quiet-zone background behind the dark modules', () => {
    const { container } = render(<QrCode url="https://example.com" />);
    const background = container.querySelector('svg > rect');
    expect(background).not.toBeNull();
    expect(background!.getAttribute('fill')).toBe('#fff');
  });

  it('encodes real module data as a single path, not one element per cell', () => {
    const { container } = render(<QrCode url="https://example.com" />);
    const path = container.querySelector('svg > path');
    expect(path).not.toBeNull();
    expect(path!.getAttribute('d')!.length).toBeGreaterThan(0);
    expect(container.querySelectorAll('svg > path')).toHaveLength(1);
  });

  it('a longer url encodes to a larger module grid', () => {
    const short = render(<QrCode url="https://a.co" />);
    const long = render(
      <QrCode url="https://example.com/a/very/long/path/that/needs/many/more/modules/to/encode/correctly" />,
    );
    const shortViewBox = short.container.querySelector('svg')!.getAttribute('viewBox')!;
    const longViewBox = long.container.querySelector('svg')!.getAttribute('viewBox')!;
    const shortSize = Number(shortViewBox.split(' ')[2]);
    const longSize = Number(longViewBox.split(' ')[2]);
    expect(longSize).toBeGreaterThan(shortSize);
  });

  it('respects a custom size prop for the rendered pixel dimensions', () => {
    const { container } = render(<QrCode url="https://example.com" size={200} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('200');
    expect(svg.getAttribute('height')).toBe('200');
  });
});
