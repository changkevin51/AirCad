/*
 * AirCAD "Smart Pen" remote - ESP32 BLE keyboard, four buttons.
 *
 * This sketch is deliberately a dumb transport.  It reports nothing but button
 * press/release; every mode, threshold, chord and CAD action lives in AirCAD
 * (web/src/input/remote.ts).  That split means the on-screen HUD can show the
 * current mode, the timings can be tuned without reflashing, and the same
 * remote works on macOS and Windows with no per-OS build.
 *
 * Button layout: 1 and 2 are on the right, 3 and 4 on the left.
 *
 *   button 1 -> F17   hold: draw / orbit / pan by mode, or the drag grab
 *                     tap: select, tap twice: undo
 *   button 2 -> F18   tap: cycle mode 1 -> 2 -> 3 -> 1
 *   button 3 -> F19   tap: Tab (work plane, or the active face while pulling)
 *                     hold: voice, release finalises
 *   button 4 -> F20   tap: Q to open a push/pull, tap again to apply
 *                     hold: move, release applies
 *   2 + 4             fit the view
 *   2 + 3             release everything
 *
 * F17-F20 are used rather than digits because AirCAD already binds 1/2/3 to
 * view presets, and because those keys are not printable: a button press can
 * never type into the measure dialog or the inspector.
 *
 * Do not move these down to F13-F16.  macOS assigns F13 to Print Screen and
 * F14/F15 to screen brightness, so those buttons trigger system actions instead
 * of reaching the browser.  F17-F20 have no default binding on macOS or
 * Windows, and unlike F21+ they still have macOS virtual key codes, so the
 * browser reports them as proper KeyboardEvent.code values.
 *
 * Library: T-vK/ESP32-BLE-Keyboard (defines KEY_F13..KEY_F24).
 * Verify pairing in AirCAD with `window.aircad.remote().lastCode`, which shows
 * the code the browser actually received.
 */
#include <Arduino.h>
#include <BleKeyboard.h>

/*
 * Serial diagnostics.  MUST stay 0 with the current pin map.
 *
 * Button 2 is on GPIO1, which is UART0 TX on a classic ESP32.  Serial.begin()
 * drives that pin as an output, and a button cannot pull down a driven output,
 * so enabling this silently kills button 2.  Only turn it on after rewiring the
 * buttons to {5, 18, 19, 4}.
 *
 * Open Arduino IDE -> Tools -> Serial Monitor at 115200 when it is enabled.
 */
#define DEBUG_SERIAL 0

/*
 * POWER: do not run this on a USB data cable to the computer.
 *
 * Buttons 1 and 2 sit on GPIO0 and GPIO1.  While a data cable is attached, the
 * board's USB-serial bridge drives DTR/RTS into the GPIO0 auto-reset circuit and
 * holds that pin, so button 1 never registers.  Use a phone charger, a power
 * bank, or a battery — power only, no data — and both buttons come back.
 */
BleKeyboard bleKeyboard("Smart Pen", "Maker", 100);

/*
 * Pins, for a classic ESP32 (WROOM / DevKitC).  This board's pin rules are not
 * suggestions; the original map used GPIO 0 and 1 and those two buttons were
 * simply dead:
 *
 *   GPIO1  = UART0 TX.  The ROM bootloader and Serial.begin() drive it as an
 *            output, so a button can never pull it low.  Unusable as an input.
 *   GPIO0  = boot strapping pin, and on most dev boards it is wired into the
 *            USB-serial auto-reset circuit, which holds it while USB is
 *            connected.  Also unusable in practice.
 *   GPIO3  = UART0 RX.  Readable, but the host drives it during uploads, so a
 *            held button fights the programmer.  Moved off it.
 *
 * Never use: 0, 1, 3 (boot/UART), 2, 12, 15 (other strapping pins), 6-11 (wired
 * to the SPI flash).  Avoid 34-39: they are input-only with no internal
 * pull-up, so INPUT_PULLUP silently does nothing and the pin floats.
 *
 * Safe here: 4, 5, 13, 14, 16-19, 21-23, 25-27, 32, 33.
 *
 * Kept on the original wiring because these buttons are already soldered to it
 * and they do work — but only when the board is NOT plugged into a computer's
 * USB data port.  See the power note below.  If buttons 1 and 2 ever need to
 * work while tethered, {5, 18, 19, 4} is the rewire.
 */
const int buttonPins[] = {0, 1, 3, 4};
const int numButtons = sizeof(buttonPins) / sizeof(buttonPins[0]);
// uint8_t, not char: KEY_F17..KEY_F20 are HID constants, not printable characters.
// Order must match REMOTE_BUTTON_CODES in web/src/input/remote.ts.
const uint8_t buttonKeys[] = {KEY_F17, KEY_F18, KEY_F19, KEY_F20};
// Labels only used for logging, so the monitor reads as button numbers not codes.
const char *keyNames[] = {"F17", "F18", "F19", "F20"};

int lastButtonStates[numButtons];
bool wasConnected = false;
unsigned long lastHeartbeat = 0;

void setup() {
#if DEBUG_SERIAL
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("[pen] boot");
#endif

  bleKeyboard.begin();
  for (int i = 0; i < numButtons; i++) {
    pinMode(buttonPins[i], INPUT_PULLUP);
    lastButtonStates[i] = HIGH;
  }

#if DEBUG_SERIAL
  // With INPUT_PULLUP and nothing pressed every pin should read HIGH.  A LOW
  // here means that pin is held down, shorted, or not usable as an input.
  delay(50);
  for (int i = 0; i < numButtons; i++) {
    const int pin = buttonPins[i];
    const bool reserved = pin == 0 || pin == 1 || pin == 3 || pin == 2 || pin == 12 || pin == 15
                          || (pin >= 6 && pin <= 11) || pin >= 34;
    Serial.printf("[pen] button %d -> GPIO %d -> %s : idle level %s%s\n",
                  i + 1, pin, keyNames[i],
                  digitalRead(pin) == HIGH ? "HIGH (ok)" : "LOW (stuck?)",
                  reserved ? "  <-- UNUSABLE PIN on a classic ESP32" : "");
  }
  Serial.println("[pen] waiting for the Mac to connect over Bluetooth...");
#endif
}

void loop() {
  if (!bleKeyboard.isConnected()) {
    // A button held across a dropped link never delivers its key-up, so forget
    // the held state; reconnecting with it still down sends a fresh press.
    if (wasConnected) {
#if DEBUG_SERIAL
      Serial.println("[pen] disconnected - clearing held state");
#endif
      for (int i = 0; i < numButtons; i++) lastButtonStates[i] = HIGH;
      wasConnected = false;
    }
    return;
  }
  if (!wasConnected) {
#if DEBUG_SERIAL
    Serial.println("[pen] connected");
#endif
    wasConnected = true;
  }

  for (int i = 0; i < numButtons; i++) {
    int pin = buttonPins[i];
    int currentState = digitalRead(pin);
    if (currentState != lastButtonStates[i]) {
      if (currentState == LOW) {
        bleKeyboard.press(buttonKeys[i]);
#if DEBUG_SERIAL
        Serial.printf("[pen] button %d (GPIO %d) DOWN -> sent %s\n", i + 1, pin, keyNames[i]);
#endif
      } else {
        bleKeyboard.release(buttonKeys[i]);
#if DEBUG_SERIAL
        Serial.printf("[pen] button %d (GPIO %d) UP   -> sent %s\n", i + 1, pin, keyNames[i]);
#endif
      }
      lastButtonStates[i] = currentState;
      delay(20); // Debounce
    }
  }

#if DEBUG_SERIAL
  // Raw levels every two seconds: shows a pin that never moves while you press
  // it, which no amount of AirCAD debugging would reveal.
  if (millis() - lastHeartbeat > 2000) {
    lastHeartbeat = millis();
    Serial.print("[pen] levels");
    for (int i = 0; i < numButtons; i++) {
      Serial.printf("  %d:GPIO%d=%s", i + 1, buttonPins[i], digitalRead(buttonPins[i]) == LOW ? "DOWN" : "up");
    }
    Serial.println();
  }
#endif
}
