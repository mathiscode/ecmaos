# hostnamectl

`man @ecmaos/coreutils/hostnamectl`

## Synopsis

```
hostnamectl [status] [--json=pretty|short]
hostnamectl hostname [NAME] [--static|--transient|--pretty]
hostnamectl set-hostname NAME
hostnamectl chassis|icon-name|deployment|location [VALUE]
```

## Description

Show or change the host name, and what describes the machine. There are three names:

- the static name, `/etc/hostname`, which boot gives the kernel
- the transient name, the kernel's own `/proc/sys/kernel/hostname`, which `hostname` and `uname -n` print
- the pretty name, in `/etc/machine-info`

Setting a name sets all three unless `--static`, `--transient` or `--pretty` narrows it. A name that is not a valid host name, such as `My Web Box`, becomes the pretty name, and its cleaned form (`my-web-box`) becomes the others.

The chassis, icon name, deployment and location are kept in `/etc/machine-info` too. Setting anything is root's.

`status` shows the names, the machine and boot ids, the operating system from `/etc/os-release`, the kernel and the architecture. In a page the virtualization is `browser`; on the Node host none is shown.

## See also

`hostname`, `uname`, `/etc/hostname`
