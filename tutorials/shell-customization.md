# Shell Customization

EcmaOS provides a flexible terminal configuration system that allows for both system-wide defaults and user-specific customizations. Appearance is handled via [TOML](https://toml.io) files; behavior is handled by the shell startup files documented at the end.

## Configuration Files

The terminal looks for configuration files in the following order:

1.  `/etc/terminal.toml`: System-wide default configuration.
2.  `~/.config/terminal.toml`: User-specific configuration.

Settings in the user configuration file override the system defaults.

## Configuration Options

Here is a list of available configuration options:

```toml
# Enable or disable the audio bell
noBell = false

# Font configuration
fontFamily = "FiraCode Nerd Font Mono, Ubuntu Mono, courier-new, courier, monospace"
fontSize = 16

# Cursor configuration
cursorBlink = true
cursorStyle = "block" # Options: "block", "underline", "bar"

# Smooth scrolling duration in milliseconds
smoothScrollDuration = 100

# Whether the Option key on Mac should act as Meta
macOptionIsMeta = true
```

## Themes

The shell supports theming via the `theme` configuration block. You can either use a built-in preset or define custom colors.

### Using the theme command

- `theme` - Lists all available themes
- `theme <name>` - Sets the theme to the specified name
- `theme -s <name>` - Sets the theme to the specified name and saves it to the configuration file

### Using Presets

To use a built-in theme, specify the `name` property inside the `[theme]` block:

```toml
[theme]
name = "Dracula"
```

**Available Presets:**
*   Ayu Mirage
*   Catppuccin
*   Challenger Deep
*   Cobalt2
*   Cyberpunk
*   Dracula
*   Everforest
*   Firewatch
*   Gotham
*   Gruvbox
*   Horizon
*   Iceberg
*   Kanagawa
*   Laser
*   Lucario
*   Monokai
*   Night Owl
*   Nord
*   Oceanic Next
*   One Dark
*   Palenight
*   Panda
*   Poimandres
*   Rose Pine
*   Shades of Purple
*   Snazzy
*   Solarized
*   Synthwave
*   Tokyo Night
*   TRS
*   Zenburn

### Custom Colors

You can also define custom colors:

```toml
[theme]
background = "#000000"
foreground = "#00FF00"
promptColor = "green"
```

## Example Configuration

Here is an example `~/.config/terminal.toml` that sets the font size to 18 and uses the "Dracula" theme:

```toml
fontSize = 18

[theme]
name = "Dracula"
```

## Startup Files

Appearance is TOML; behavior is shell script. At login the shell runs, in order:

1.  `/etc/profile`
2.  the first of `~/.ecmash_profile` or `~/.profile` that exists
3.  `/etc/ecmashrc`
4.  `~/.ecmashrc`

Each is an ordinary shell script, so aliases, functions, `export`, and `set` options all work:

```sh
export EDITOR=edit
alias ll='ls -la'
mkcd() { mkdir -p "$1" && cd "$1"; }
set -o noclobber
```

A file that fails prints a warning and the remaining files still run, so a mistake in one of them
costs you a message rather than a shell.
