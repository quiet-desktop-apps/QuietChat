"""Follow completed GTK layouts, without timers or retaining message widgets."""


class MessagePosition:
    def __init__(self, adjustment, changed):
        self.adjustment = adjustment
        self.changed = changed
        self.following = True
        self.position = 0
        self.paused = False
        self.applying = False
        self.bounds = self.dimensions()
        adjustment.connect('changed', self.layout_changed)
        adjustment.connect('value-changed', self.value_changed)

    def dimensions(self):
        return (self.adjustment.get_upper(), self.adjustment.get_page_size())

    def bottom(self):
        return max(0, self.adjustment.get_upper() - self.adjustment.get_page_size())

    def layout_changed(self, *_args):
        self.bounds = self.dimensions()
        if self.paused: return
        self.applying = True
        try:
            self.adjustment.set_value(self.bottom() if self.following else min(self.position, self.bottom()))
        finally:
            self.applying = False
        self.changed()

    def value_changed(self, *_args):
        # GTK can clamp the value as part of resizing. That is not a user scroll.
        if self.paused or self.applying or self.bounds != self.dimensions(): return
        self.position = self.adjustment.get_value()
        self.following = self.position >= self.bottom() - 30
        self.changed()

    def latest(self):
        self.following = True
        self.layout_changed()

    def resume(self):
        self.paused = False
        self.layout_changed()
