# Python API

## 运行环境

- 内置 CPython 3.14（with-python 包）；
- lean 包没有 Python 运行时；
- 解释器通过 Chaquopy 嵌入；
- 预编译模块必须匹配 ABI 和 Python 版本。

## 脚本结构

```python
NAME = '示例站点'
SITE = 'https://example.com'

CONFIG = [
    {'key': 'cookie', 'label': 'Cookie', 'type': 'string', 'default': ''},
]

CFG = {}  # 运行时由 App 注入

def home():
    return SITE + '/'

def search(kw):
    return SITE + '/search?q=' + str(kw)

def parse(url, html):
    return {'type': 'home', 'heroes': [], 'cats': [], 'sections': []}
```

入口必须有 `parse(url, html)`。

## 返回结构

与 JS 共用：

- `home`
- `list`
- `detail`
- `player`

```python
def parse(url, html):
    return {
        'type': 'list',
        'title': '列表',
        'cards': [
            {'title': '标题', 'pic': '', 'desc': '', 'url': 'https://example.com/1'}
        ]
    }
```

## 参数

```python
CONFIG = [
    {'key': 'mode', 'label': '模式', 'type': 'select', 'options': ['a', 'b'], 'default': 'a'}
]
```

运行时：

```python
mode = CFG.get('mode', 'a')
```

## 多文件

同目录模块：

```python
from . import helper
```

或：

```python
import helper
```

限制：

- 不支持跨目录包安装到脚本目录；
- 第三方模块通过“模块商店”安装；
- 模块需要加载到当前会话后才能 import。

## 预编译模块

模块商店里的 `android` 级别模块是预编译轮子：

- 必须匹配 ABI；
- 必须匹配 Python 3.14；
- 没有适配轮子时商店会提示，不下载；
- 安装后自动加载到当前 Python 会话。

## 自定义主页 py 区块

```py:
"<h2>你好</h2>"
```

- 表达式结果作为 HTML；
- 可以 import 已加载的预编译模块生成字符串；
- 失败会在区块内显示错误，不影响其他模块。

## 终端 Python

```sh
python
```

进入 `>>>`，`exit()` 或 Ctrl+D 回 shell。

## 常见错误

| 错误 | 原因 |
|---|---|
| `python-not-linked` | 当前是 lean 包 |
| `ModuleNotFoundError` | 模块未安装或未加载 |
| `ABI mismatch` | 预编译轮子与设备 ABI 不匹配 |
| 语法错误 | 用脚本编辑器语法检查定位 |
