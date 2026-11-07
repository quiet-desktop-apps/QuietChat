"""Physical Portuguese dead keys and GTK Unicode composition in an isolated X display."""
import subprocess
from app import Gdk


def exercise(app, press, pump, row_count):
    subprocess.run(['setxkbmap', '-layout', 'pt'], check=True, capture_output=True)
    pump(.2)
    try:
        app.composer.grab_focus()
        app.composer.get_buffer().set_text('')
        for letter in 'aeiou':
            press(Gdk.KEY_dead_acute); press(ord(letter))
        for letter in 'ao':
            press(Gdk.KEY_dead_tilde); press(ord(letter))
        for letter in 'aeo':
            press(Gdk.KEY_dead_circumflex, shift=True); press(ord(letter))
        press(Gdk.KEY_dead_grave, shift=True); press(ord('a'))
        press(Gdk.KEY_ccedilla)
        press(Gdk.KEY_dead_acute); press(ord('a'), shift=True)
        expected = 'áéíóúãõâêôàçÁ'
        assert app.text() == expected, f'Portuguese dead keys produced {app.text()!r}'
        assert row_count(expected) == 0, 'Accent composition sent the message'
        app.composer.get_buffer().set_text('Unicode: ')
        press(ord('u'), control=True, shift=True)
        press(ord('e')); press(ord('1')); press(Gdk.KEY_Return)
        assert app.text() == 'Unicode: á', f'Unicode composition produced {app.text()!r}'
        assert row_count('Unicode: ') == 0 and row_count('Unicode: á') == 0, 'Composition Enter must not send'
        press(Gdk.KEY_Return)
        pump(.4)
        assert row_count('Unicode: á') == 1, 'A second Enter must send the completed text'
        app.composer.get_buffer().set_text('Cancel: ')
        press(ord('u'), control=True, shift=True)
        press(ord('e')); press(Gdk.KEY_Escape)
        press(Gdk.KEY_dead_acute); press(ord('a'))
        assert app.text() == 'Cancel: á', 'Escape must cancel composition without leaving the input stuck'
    finally:
        app.composer.get_buffer().set_text('')
        subprocess.run(['setxkbmap', '-layout', 'us'], check=True, capture_output=True)
        pump(.2)
