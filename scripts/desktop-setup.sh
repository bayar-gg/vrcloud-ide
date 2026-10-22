#!/usr/bin/env bash
# Pasang desktop virtual untuk fitur Remote Desktop VRCloud IDE di server Linux tanpa GUI:
# Xvfb (layar virtual), XFCE (desktop ringan), xdotool (input), ImageMagick (tangkap layar).
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "Jalankan sebagai root." >&2
  exit 1
fi

install_enterprise_linux_desktop() {
  local pm="$1"
  echo "[$pm] mengaktifkan EPEL dan repository paket desktop"
  "$pm" install -y epel-release
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y dnf-plugins-core >/dev/null 2>&1 || true
    dnf config-manager --set-enabled crb >/dev/null 2>&1 \
      || dnf config-manager --set-enabled powertools >/dev/null 2>&1 \
      || true
  fi

  echo "[$pm] memasang Xvfb, XFCE, xdotool, dan ImageMagick"
  "$pm" install -y \
    xorg-x11-server-Xvfb \
    xfce4-session xfce4-panel xfdesktop xfwm4 xfce4-terminal \
    xdotool ImageMagick dbus-x11 dejavu-sans-fonts

  # Menyediakan xdpyinfo/xsetroot pada sebagian versi EL. DesktopRemote tetap
  # berfungsi tanpa paket opsional ini bila tool inti di atas tersedia.
  "$pm" install -y xorg-x11-utils xorg-x11-server-utils >/dev/null 2>&1 || true
}

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  echo "[apt] memperbarui indeks paket"
  apt-get update -qq
  echo "[apt] memasang xvfb xfce4 xfce4-terminal dbus-x11 xdotool imagemagick x11-utils x11-xserver-utils"
  apt-get install -y -qq --no-install-recommends xvfb xfce4 xfce4-terminal dbus-x11 xdotool imagemagick x11-utils x11-xserver-utils fonts-dejavu-core
elif command -v dnf >/dev/null 2>&1; then
  install_enterprise_linux_desktop dnf
elif command -v yum >/dev/null 2>&1; then
  install_enterprise_linux_desktop yum
elif command -v pacman >/dev/null 2>&1; then
  echo "[pacman] memasang paket"
  pacman -Sy --noconfirm xorg-server-xvfb xfce4 xdotool imagemagick xorg-xdpyinfo xorg-xprop xorg-xsetroot
elif command -v apk >/dev/null 2>&1; then
  echo "[apk] memasang paket"
  apk add --no-cache xvfb xfce4 xfce4-terminal xdotool imagemagick xdpyinfo xprop xsetroot dbus-x11
else
  echo "Manajer paket tidak dikenali. Pasang manual: Xvfb, xfce4, xdotool, imagemagick, xdpyinfo." >&2
  exit 1
fi

# ImageMagick di beberapa distro membatasi `import`; longgarkan bila ada policy.
for pol in /etc/ImageMagick-6/policy.xml /etc/ImageMagick-7/policy.xml /etc/ImageMagick/policy.xml; do
  [[ -f "$pol" ]] && sed -i 's/rights="none" pattern="\(XPS\|PS\|PDF\|EPS\)"/rights="read|write" pattern="\1"/g' "$pol" || true
done

echo "Selesai. Desktop virtual akan dijalankan otomatis (DISPLAY :99) saat Remote Desktop dibuka dari IDE."
