import React, { useState } from 'react';
import { QrCode, Zap, ArrowRight, Shield } from 'lucide-react';
import LogoImg from '../logo.png';

const SEEN_KEY = 'weshare_onboarded';

// Remembered in localStorage and a cookie. localStorage is kept per address (scheme + port),
// so after switching between HTTP and HTTPS the cookie, which is shared by every port and
// scheme on the same host, still says the intro was seen.
export function hasSeenOnboarding(): boolean {
  try {
    if (localStorage.getItem(SEEN_KEY) === 'true') return true;
  } catch {}
  try {
    return document.cookie.split(';').some((c) => c.trim() === `${SEEN_KEY}=1`);
  } catch {
    return false;
  }
}

// Phones and browsers are served by the computer's own server, which remembers who has
// seen the intro (by network address), so a new address or a cleared browser doesn't
// bring it back. The desktop window keeps its own storage and doesn't ask.
const servedByHost = () => !(window as any).electronAPI && /^https?:$/.test(window.location.protocol);

/** Asks the computer whether this visitor has seen the intro before. False if it can't tell. */
export async function askHostIfOnboardingSeen(timeoutMs = 2000): Promise<boolean> {
  if (!servedByHost()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/intro-seen', { signal: controller.signal, cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.seen === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function rememberLocally() {
  try {
    localStorage.setItem(SEEN_KEY, 'true');
  } catch {}
  try {
    document.cookie = `${SEEN_KEY}=1; max-age=${60 * 60 * 24 * 365 * 5}; path=/; SameSite=Lax`;
  } catch {}
}

export function markOnboardingSeen() {
  rememberLocally();
  if (servedByHost()) {
    fetch('/api/intro-seen', { method: 'POST' }).catch(() => {});
  }
}

/** Saves the flag on this device after the computer said the intro was already seen. */
export function rememberOnboardingSeen() {
  rememberLocally();
}

interface OnboardingProps {
  onComplete: () => void;
}

export const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const [currentSlide, setCurrentSlide] = useState(0);

  const slides = [
    {
      icon: <img src={LogoImg} alt="Weshare Logo" style={{ width: '100px', height: '100px', objectFit: 'contain', filter: 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.4))' }} />,
      title: "Ultra-Fast Offline Sharing",
      description: "Share files directly between your devices using local Wi-Fi. Zero internet connection required. Zero cloud tracking."
    },
    {
      icon: <QrCode size={80} />,
      title: "Instant QR Pairing",
      description: "Just scan the pairing QR code on your phone's camera to establish a secure, local connection in less than 2 seconds."
    },
    {
      icon: <Zap size={80} />,
      title: "Engineered for Large Files",
      description: "Transfer high-resolution movies, large folder structures, and developer archives at maximum gigabit speed."
    },
    {
      icon: <Shield size={80} />,
      title: "Secure & Offline-First",
      description: "Your files never leave your local network. Protected by temporary session token authentication."
    }
  ];

  const handleNext = () => {
    if (currentSlide < slides.length - 1) {
      setCurrentSlide(currentSlide + 1);
    } else {
      markOnboardingSeen();
      onComplete();
    }
  };

  const handleSkip = () => {
    markOnboardingSeen();
    onComplete();
  };

  return (
    <div className="onboarding-overlay">
      <div className="glass-panel onboarding-card">
        <div className="onboarding-illustration">
          {slides[currentSlide].icon}
        </div>
        <h2 style={{ fontSize: '26px', marginBottom: '16px', fontFamily: 'var(--font-title)' }}>
          {slides[currentSlide].title}
        </h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: '1.6', fontSize: '15px', marginBottom: '24px' }}>
          {slides[currentSlide].description}
        </p>

        <div className="onboarding-dots">
          {slides.map((_, index) => (
            <div
              key={index}
              className={`onboarding-dot ${index === currentSlide ? 'active' : ''}`}
            />
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
          {currentSlide < slides.length - 1 ? (
            <button className="interactive-btn" onClick={handleSkip} style={{ color: 'var(--text-muted)' }}>
              Skip Intro
            </button>
          ) : (
            <div />
          )}

          <button className="interactive-btn primary" onClick={handleNext}>
            {currentSlide === slides.length - 1 ? "Get Started" : "Continue"}
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};
