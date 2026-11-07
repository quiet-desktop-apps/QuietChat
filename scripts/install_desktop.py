"""Install launchers linked to this checkout, without copying application code."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

APP_ID = "ch.aboimpinto.QuietChat"


def desktop_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")


def exec_argument(value: str) -> str:
    escaped = "".join("\\" + char if char in '\\"`$' else char for char in value)
    return '"' + desktop_string(escaped).replace("%", "%%") + '"'


def link(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        target.unlink()
    elif target.exists():
        raise FileExistsError(f"Refusing to overwrite an existing regular file: {target}")
    target.symlink_to(source)


def install(project: Path, data_home: Path, bin_home: Path) -> Path:
    project = project.resolve()
    launcher = project / "launch.sh"
    icon = project / "assets" / f"{APP_ID}.svg"
    unread_icon = project / "assets" / f"{APP_ID}-unread.svg"
    for path in (launcher, project / "run.sh", project / "native.sh", icon, unread_icon):
        if not path.is_file():
            raise FileNotFoundError(path)
    command = bin_home / "quietchat"
    entry = data_home / "applications" / f"{APP_ID}.desktop"
    # Check collisions before writing any part of the installation.
    icons = {directory / source.name: source
             for directory in (data_home / "icons/hicolor/scalable/apps", data_home / "icons")
             for source in (icon, unread_icon, *sorted((project / 'assets').glob(f'{APP_ID}-unread-*.svg')))}
    for path in [command, *icons]:
        if path.exists() and not path.is_symlink():
            raise FileExistsError(f"Refusing to overwrite an existing regular file: {path}")
    if entry.exists() and "X-QuietChat-Workspace=" not in entry.read_text():
        raise FileExistsError(f"Refusing to overwrite an unrelated launcher: {entry}")
    link(launcher, command)
    for path, source in icons.items():
        link(source, path)
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text(
        "[Desktop Entry]\nVersion=1.0\nType=Application\nName=QuietChat\n"
        "Comment=Lightweight WhatsApp chats, images and videos\n"
        f"Exec={exec_argument(str(launcher))} --desktop\n"
        f"Path={desktop_string(str(project))}\n"
        f"Icon={desktop_string(str(icon))}\n"
        "Terminal=false\nStartupNotify=true\n"
        f"StartupWMClass={APP_ID}\n"
        "Categories=Network;InstantMessaging;\nKeywords=WhatsApp;chat;messages;Quiet;\n"
        f"X-QuietChat-Workspace={desktop_string(str(project))}\n",
        encoding="utf-8",
    )
    entry.chmod(0o644)
    if shutil.which("desktop-file-validate"):
        subprocess.run(["desktop-file-validate", str(entry)], check=True)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(entry.parent)], check=True, capture_output=True)
    if shutil.which("gtk-update-icon-cache"):
        subprocess.run(["gtk-update-icon-cache", "-f", "-t", str(data_home / "icons/hicolor")], capture_output=True)
    print(f"Installed command: {command} -> {launcher}")
    print(f"Installed desktop launcher: {entry}")
    print(f"Source of truth: {project}")
    print("Run quietchat (or quietchat start), or search for QuietChat in Applications.")
    print("Every launch builds this checkout. Restart QuietChat to use new source changes.")
    return entry


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-home", type=Path, default=Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))))
    parser.add_argument("--bin-home", type=Path, default=Path.home() / ".local/bin")
    args = parser.parse_args()
    install(Path(__file__).resolve().parents[1], args.data_home.resolve(), args.bin_home.resolve())
