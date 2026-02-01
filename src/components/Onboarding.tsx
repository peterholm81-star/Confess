/**
 * Onboarding - 4-screen intro flow for new users
 * 
 * Shows once on first launch, persists completion to localStorage.
 * Matches the dark, quiet visual style of the app.
 */

import { useState } from 'react'

interface OnboardingProps {
  onComplete: () => void
}

const SCREENS = [
  {
    title: "If no one ever knew, I would…",
    body: "A place for the thoughts you never say out loud.",
  },
  {
    title: "Nothing lasts",
    body: "Confessions stay for 24 hours. Then they're gone.",
  },
  {
    title: "Listen anywhere",
    body: "Read from anywhere in the world.",
  },
  {
    title: "Confess where you stand",
    body: "You can only post from where you are. No profiles. No history.",
  },
]

export function Onboarding({ onComplete }: OnboardingProps) {
  const [currentScreen, setCurrentScreen] = useState(0)

  const isLastScreen = currentScreen === SCREENS.length - 1
  const screen = SCREENS[currentScreen]

  function handleContinue() {
    if (isLastScreen) {
      onComplete()
    } else {
      setCurrentScreen((prev) => prev + 1)
    }
  }

  function handleSkip() {
    onComplete()
  }

  return (
    <div className="onboarding-overlay">
      <button className="onboarding-skip" onClick={handleSkip}>
        Skip
      </button>

      <div className="onboarding-content">
        <h2 className="onboarding-title">{screen.title}</h2>
        <p className="onboarding-body">{screen.body}</p>

        <div className="onboarding-dots">
          {SCREENS.map((_, index) => (
            <span
              key={index}
              className={`onboarding-dot${index === currentScreen ? ' active' : ''}`}
            />
          ))}
        </div>

        <button className="onboarding-cta" onClick={handleContinue}>
          {isLastScreen ? 'Enter' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
