# Setting up a Voice2Baby Speaker

This guide is for the doctor or nurse setting up a new speaker. No technical
experience needed. It takes about 10 minutes, and you only do it once per
speaker. For normal home/clinic Wi-Fi you won't need any help from IT. For a
**university or hospital "enterprise" network** (the kind that asks for a
*username and password*, like eduroam), you'll need a few details from IT first
— see "What you'll need" below.

---

## What you'll need

- A **Raspberry Pi** (the small computer) with its **power adapter**.
- A **memory card** (microSD, 8 GB or larger).
- A **small speaker** that plugs into the Raspberry Pi (USB or headphone-style).
- Any **computer** (Windows or Mac) with a memory-card slot, or a small USB
  card reader.
- Your **Wi-Fi details** — one of:
  - **Normal Wi-Fi:** the **network name** and **password**.
  - **University/enterprise Wi-Fi** (asks for a *username* and password): the
    **network name**, a **username and password** (ideally a *device/service
    account* from IT — not a personal login, so it keeps working long-term), and,
    if IT provides them, the network's **security certificate file** and its
    **server domain** (e.g. `vcu.edu`).

*(The hardware comes in the starter kit — you don't have to figure out which parts to buy.)*

---

## Part 1 — Prepare the memory card (on your computer)

1. Put the **memory card** into your computer (or into the card reader, then
   into the computer).

2. Install the free app **"Raspberry Pi Imager"**:
   - Download it from **https://www.raspberrypi.com/software/**
   - Open it once it's installed.

3. Click **"Choose OS"** → scroll to the bottom → click **"Use custom"** →
   select the **NICU Speaker** file you downloaded from us:
   👉 *[NICU Speaker image — download link goes here]*

4. Click **"Choose Storage"** → pick your **memory card** from the list.
   ⚠️ Make sure it's the memory card and not another drive — this step erases it.

5. Click **"Next."** If it asks *"Would you like to apply OS customisation
   settings?"*, click **"No"** — you'll set the Wi-Fi in an easier way in a moment.
   Wait a few minutes while it copies. When it's done, it ejects the card.

6. **Set your Wi-Fi (this is the important step):**
   - Take the memory card out and **put it back in** your computer.
   - A drive named **`bootfs`** appears. Open it.
   - Open the file **`wifi.txt`** (double-click; it opens in a text editor).
   - Fill in **one** of the three options below, matching your Wi-Fi. Only change
     the values after each `=`; leave the labels as they are.

   **A) Normal Wi-Fi** — a network name and one password (most homes/clinics):
   ```
   security=wpa-psk
   ssid=NICU-Staff-WiFi
   password=mypassword123
   ```

   **B) University / enterprise Wi-Fi** — asks for a *username and password*
   (e.g. eduroam or a campus network):
   ```
   security=wpa-eap
   ssid=eduroam
   identity=deviceaccount@vcu.edu
   password=the-account-password
   ```
   If IT gave you a **security certificate**, copy that `.pem` file onto this same
   `bootfs` drive, then also set these two lines (ask IT for the domain):
   ```
   ca_cert=/boot/firmware/ca.pem
   domain_suffix_match=vcu.edu
   ```

   **C) Open Wi-Fi** — no password:
   ```
   security=open
   ssid=Guest-WiFi
   ```

   - (If you're outside the US, change the `country` line to your 2-letter code.)
   - **Save** the file and close it. Eject the card safely.

   > 💡 You can change the Wi-Fi later **without redoing everything** — just put
   > the card back into a computer, edit `wifi.txt`, save, and slide it back into
   > the speaker. It picks up the new network on its next restart.

---

## Part 2 — Start the speaker

7. Put the **memory card** into the Raspberry Pi (it clicks into the slot).

8. Plug the **speaker** into the Raspberry Pi.

9. Plug in the **power adapter**. The Raspberry Pi turns on by itself.

10. **Wait about 5 minutes.** The first time, it installs itself, restarts once
    on its own, then connects. This is normal — you don't need to do anything,
    and there's no screen or keyboard to plug in. (Every start after this is quick.)

---

## Part 3 — Connect the speaker to a baby (on the website)

11. Open the **Voice2Baby website** (voice2baby.com) and sign in.

12. Go to the **Speakers** page. Your new speaker appears in the list, marked
    **"Online."**
    *(If it's not there yet, give it another minute and refresh the page.)*

13. Click **"Assign"** next to it and choose the **baby** this speaker belongs to.

That's it — the speaker is ready. Parents' recordings will now play in that
baby's room.

---

## If something's not right

- **The speaker never showed up on the website:**
  - Check that your Wi-Fi details were typed correctly in Part 1, step 6 — the
    right `security=` line for your network type, and the name/password (and
    username, for enterprise). You can just re-edit `wifi.txt` on the card and
    slide it back in — no need to re-flash.
  - On an **enterprise/university** network, if it still won't appear, the campus
    firewall may be blocking the speaker. Note the speaker never needs any inbound
    access — only outbound to AWS — and share that with IT.
  - Make sure the power adapter is plugged in and the little light on the
    Raspberry Pi is on.
  - Give it a full 5 minutes on the first start.

- **It shows up but there's no sound:** check the speaker is plugged in and
  turned on, then use the **"Test speaker"** button on the Speakers page.

- **Still stuck?** Note the speaker's name from the website (like `PI-00042`)
  and contact support — you won't need to open anything technical.

---

*You can move a speaker to a different baby any time from the Speakers page —
just click "Unassign," then "Assign" to the new baby. No re-setup needed.*
