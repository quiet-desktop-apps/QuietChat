"""Real GTK layout/scrolling with bounded synthetic history and no account data."""


def exercise(app, pump, wait, pointer_button=None):
    from app import Gtk
    saved = dict(app.current)
    request = app.bridge.request
    chat = {'id': 'scroll-test@g.us', 'name': 'Long conversation', 'unread': 0}
    history = [dict(chat=chat['id'], id=f'scroll-{i}', sender='Demo person', mine=i % 2 == 0,
                    time=1800000000+i, text=f'Message {i}\n' + 'A long conversation with wrapping text. ' * 12,
                    kind='text') for i in range(125)]
    pending = []
    hold = False

    def synthetic(action, callback=None, **args):
        if action == 'messages' and args['chat'] == chat['id']:
            end = len(history) - args['offset']
            result = {'name': chat['name'], 'messages': history[max(0, end-60):end]}
            if hold: pending.append((callback, result))
            else: callback(result, None)
        else: request(action, callback, **args)

    app.bridge.request = synthetic
    adj = app.message_scroll.get_vadjustment()
    def bottom(): return max(0, adj.get_upper()-adj.get_page_size())
    def at_bottom():
        if not app.messages: return False
        last = app.message_boxes[app.messages[-1]['id']]
        ok, bounds = last.compute_bounds(app.message_scroll)
        return (bottom() > 1000 and abs(adj.get_value()-bottom()) < 2 and ok
                and bounds.get_y() < app.message_scroll.get_height()
                and bounds.get_y()+bounds.get_height() > 0
                and bounds.get_y()+bounds.get_height() <= app.message_scroll.get_height()+2)
    try:
        app.open_chat(chat)
        wait(at_bottom, 'Opening long history did not land on its latest message')
        assert not app.latest_button.get_visible() and len(app.messages) == 60
        if pointer_button:
            pointer_button(app.message_scroll, 4)
            pump(.3)
            assert not at_bottom() and app.latest_button.get_visible(), 'Mouse wheel did not scroll away from latest'
            pointer_button(app.latest_button)
            wait(at_bottom, 'Physical shortcut click did not reveal the last message')
        # A late image/layout allocation must keep the last message visible.
        pump(.2)
        extra = Gtk.Label(label='Delayed media layout', height_request=700)
        app.message_boxes[app.messages[0]['id']].append(extra)
        pump(.25); assert at_bottom(), 'Late layout lost the bottom anchor'
        # User scrolling cancels following, even when a thumbnail resizes later.
        adj.set_value(300); pump(.1)
        assert app.latest_button.get_visible()
        extra.set_size_request(-1, 1000); pump(.25)
        assert abs(adj.get_value()-300) < 2, 'Late media pulled the reader away'
        history[-1] = dict(history[-1], text='Updated latest message')
        app.refresh_messages(); pump(.3)
        assert abs(adj.get_value()-300) < 2, 'A refresh pulled the reader to the bottom'
        app.latest_button.emit('clicked'); pump(.2)
        assert at_bottom() and not app.latest_button.get_visible()
        # Even an unchanged response must honor an explicit follow request.
        adj.set_value(0); app.refresh_messages(follow=True); pump(.2)
        assert at_bottom()
        app.change_page(60); pump(.3)
        assert app.offset == 60 and app.messages[-1]['id'] == 'scroll-64'
        assert app.latest_button.get_visible(), 'Older page has no shortcut to latest'
        app.latest_button.emit('clicked'); pump(.3)
        assert app.offset == 0 and app.messages[-1]['id'] == 'scroll-124' and at_bottom()
        assert len(app.messages) == 60 and not app.latest_button.get_visible()
        # Reflow must agree with the scrollbar too, not just change its number.
        width, height = app.window.get_width(), app.window.get_height()
        app.window.set_default_size(width+180, height+100)
        pump(.3); assert at_bottom(), 'Resizing desynchronized the viewport'
        app.window.set_default_size(width, height)
        pump(.3); assert at_bottom(), 'Restoring size desynchronized the viewport'
        # Cancel pending position work when widgets are released to the tray.
        app.message_position.latest()
        app.hide_window()
        assert app.message_position.source is None and not app.latest_button.get_visible()
        app.show_chat(None)
        wait(at_bottom, 'Restoring long history from the tray lost its latest message')
        # Stale history replies must not scroll or replace a newly opened chat.
        hold = True; app.change_page(60)
        app.open_chat(saved)
        wait(lambda: app.messages and app.messages[0]['chat'] == saved['id'], 'Could not switch back')
        for callback, result in pending: callback(result, None)
        pump(.2)
        assert app.current['id'] == saved['id'] and app.messages[0]['chat'] == saved['id']
        print('Long history opens at bottom; late layout follows; reading position stays; latest shortcut resets paging; stale replies ignored.')
    finally:
        app.bridge.request = request
        if app.current['id'] != saved['id']: app.open_chat(saved)
