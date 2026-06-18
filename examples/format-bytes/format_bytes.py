"""Human-readable byte sizes. format_bytes(1536) -> "1.5 KB"."""

_UNITS = ("B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB")


def format_bytes(num_bytes):
    """Format a non-negative byte count as a human-readable string.

    Values below 1024 are rendered as an integer count of bytes with a
    "B" suffix (e.g. ``"512 B"``). At and above 1024 the value is scaled
    by successive 1024-powers into KB/MB/GB/... and rendered with exactly
    one decimal place (e.g. ``"1.0 KB"``, ``"1.5 KB"``).

    Raises:
        ValueError: if ``num_bytes`` is None, not a real number (bools are
            rejected), or negative.
    """
    if num_bytes is None or isinstance(num_bytes, bool) or not isinstance(num_bytes, (int, float)):
        raise ValueError(f"num_bytes must be a non-negative number, got {num_bytes!r}")
    if num_bytes < 0:
        raise ValueError(f"num_bytes must be non-negative, got {num_bytes!r}")

    if num_bytes < 1024:
        return f"{int(num_bytes)} {_UNITS[0]}"

    value = float(num_bytes)
    index = 0
    while value >= 1024 and index < len(_UNITS) - 1:
        value /= 1024.0
        index += 1
    return f"{value:.1f} {_UNITS[index]}"
