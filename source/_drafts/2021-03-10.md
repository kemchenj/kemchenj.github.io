---
title: 【译】SE-0298 Async/Await 序列
date: 2021-03-10
---

> 原文链接：[SE-0298 Async/Await: Sequences](https://github.com/apple/swift-evolution/blob/main/proposals/0298-asyncsequence.md)

* Proposal: [SE-0298](https://github.com/apple/swift-evolution/blob/main/proposals/0298-asyncsequence.md)
* Authors: [Tony Parker](https://github.com/parkera), [Philippe Hausler](https://github.com/phausler)
* Review Manager: [Doug Gregor](https://github.com/DougGregor)
* Status: **Implemented (Swift 5.5)**
* Implementation: [apple/swift#35224](https://github.com/apple/swift/pull/35224)
* Decision Notes: [Rationale](https://forums.swift.org/t/accepted-with-modification-se-0298-async-await-sequences/44231)
* Revision: Based on [forum discussion](https://forums.swift.org/t/pitch-clarify-end-of-iteration-behavior-for-asyncsequence/45548)


## 简介

<!--
Swift's [async/await](https://github.com/apple/swift-evolution/blob/main/proposals/0296-async-await.md) feature provides an intuitive, built-in way to write and use functions that return a single value at some future point in time. We propose building on top of this feature to create an intuitive, built-in way to write and use functions that return many values over time.
-->

Swift 的 [async/await](https://github.com/apple/swift-evolution/blob/main/proposals/0296-async-await.md) 特性提供了一种直观的、内建的方式来编写和使用在未来某个时间点返回一个值的函数。我们建议在这个特性的基础上，添加一种直观的、内置的方式来编写和使用在一段时间内返回多个值的函数。

<!--
This proposal is composed of the following pieces:
-->

本提案由以下三个部分组成：

<!--
1. A standard library definition of a protocol that represents an asynchronous sequence of values
2. Compiler support to use `for...in` syntax on an asynchronous sequence of values
3. A standard library implementation of commonly needed functions that operate on an asynchronous sequence of values
-->

1. 增加一个表示异步序列的协议到标准库里
2. 在异步序列上使用 `for...in` 语法的编译器支持
3. 对异步序列进行操作的通用函数的标准库实现

<!--more-->

## 动机

<!--
We'd like iterating over asynchronous sequences of values to be as easy as iterating over synchronous sequences of values. An example use case is iterating over the lines in a file, like this:
-->

我们希望在异步序列上的遍历能够像在同步序列上的遍历一样简单。一个例子是遍历文件的每一行，像这样：

```swift
for try await line in myFile.lines() {
  // Do something with each line
}
```

<!--
Using the `for...in` syntax that Swift developers are already familiar with will reduce the barrier to entry when working with asynchronous APIs. Consistency with other Swift types and concepts is therefore one of our most important goals. The requirement of using the `await` keyword in this loop will distinguish it from synchronous sequences.
-->

使用 Swift 开发者已经熟悉的 `for...in` 语法可以降低异步 API 的入门门槛。因此，保持与其他 Swift 类型和概念的一致性是我们最重要的目标之一。在这个循环中使用 `await` 关键字的可以把它与同步序列区分开来。

### `for/in` 语法

<!--
To enable the use of `for in`, we must define the return type from `func lines()` to be something that the compiler understands can be iterated. Today, we have the `Sequence` protocol. Let's try to use it here:
-->

为了实现 `for in` 语法，我们必须将 `func lines()` 的返回类型定义为可迭代的某些东西（编译器能理解的）。目前我们有 `Sequence` 协议。可以试着在这里使用它：

```swift
extension URL {
  struct Lines: Sequence { /* ... */ }
  func lines() async -> Lines
}
```

<!--
Unfortunately, what this function actually does is wait until *all* lines are available before returning. What we really wanted in this case was to await *each* line. While it is possible to imagine modifications to `lines` to behave differently (e.g., giving the result reference semantics), it would be better to define a new protocol to make this iteration behavior as simple as possible.
-->

不幸的是，这个函数实际上做的是等待，直到**所有行**都可用时才返回。在这种情况下，我们真正想要的是 await **每一行**。虽然可以想象对 `lines` 进行修改，使其行为不同（例如，让结果的类型变成引用语义），但最好是定义一个新的协议，使这种迭代行为尽可能简单。

```swift
extension URL {
  struct Lines: AsyncSequence { /* ... */ }
  func lines() async -> Lines
}
```

<!--
`AsyncSequence` allows for waiting on each element instead of the entire result by defining an asynchronous `next()` function on its associated iterator type.
-->

`AsyncSequence` 通过在其关联的迭代器类型上定义一个异步 `next()` 函数，允许对每个元素而不是整个结果进行等待。

### 新增的 AsyncSequence 函数

<!--
Going one step further, let's imagine how it might look to use our new `lines` function in more places. Perhaps we want to process lines until we reach one that is greater than a certain length.
-->

再进一步，让我们想象一下，在更多的地方使用我们新的 `lines` 函数会是什么样子。也许我们想处理每一行，直到其中一行的长度大于一定的长度。

```swift
let longLine: String?
do {
  for try await line in myFile.lines() {
    if line.count > 80 {
      longLine = line
      break
    }
  }
} catch {
  longLine = nil // file didn't exist
}
```

<!--
Or, perhaps we actually do want to read all lines in the file before starting our processing:
-->

又或者，我们实际上是想在开始处理之前读取文件中的所有行：

```swift
var allLines: [String] = []
do {
  for try await line in myFile.lines() {
    allLines.append(line)
  }
} catch {
  allLines = []
}
```

<!--
There's nothing wrong with the above code, and it must be possible for a developer to write it. However, it does seem like a lot of boilerplate for what might be a common operation. One way to solve this would be to add more functions to `URL`:
-->

上面的代码没有错，开发者一定可以写出来。然而，对于普通的操作来说，它确实看起来会多很多模版代码。解决这个问题其中一个方式是在 `URL` 中增加更多的函数： 

```swift
extension URL {
  struct Lines : AsyncSequence { }

  func lines() -> Lines
  func firstLongLine() async throws -> String?
  func collectLines() async throws -> [String]
}
```

<!--
It doesn't take much imagination to think of other places where we may want to do similar operations, though. Therefore, we believe the best place to put these functions is instead as an extension on `AsyncSequence` itself, specified generically -- just like `Sequence`.
-->

不过，可以想象我们可能会在其他地方进行类似的操作。因此，我们认为最好是将这些函数作为 `AsyncSequence` 本身的扩展，用一种更泛用的方式 -- 就像 `Sequence` 一样。

## 解决方案

<!--
The standard library will define the following protocols:
-->

标准库将会添加以下两个协议：

```swift
public protocol AsyncSequence {
  associatedtype AsyncIterator: AsyncIteratorProtocol where AsyncIterator.Element == Element
  associatedtype Element
  __consuming func makeAsyncIterator() -> AsyncIterator
}

public protocol AsyncIteratorProtocol {
  associatedtype Element
  mutating func next() async throws -> Element?
}
```

<!--
The compiler will generate code to allow use of a `for in` loop on any type which conforms with `AsyncSequence`. The standard library will also extend the protocol to provide familiar generic algorithms. Here is an example which does not actually call an `async` function within its `next`, but shows the basic shape:
-->

编译器将会自动生成代码，让我们可以在符合 `AsyncSequence` 的任何类型上使用 `for in` 循环。标准库还将扩展协议以提供熟悉的通用算法。下面是一个例子，它实际上并没有在其 `next` 中调用 `async` 函数，但是展示了基本的概念：

```swift
struct Counter : AsyncSequence {
  let howHigh: Int

  struct AsyncIterator : AsyncIteratorProtocol {
    let howHigh: Int
    var current = 1
    mutating func next() async -> Int? {
      // We could use the `Task` API to check for cancellation here and return early.
      guard current <= howHigh else {
        return nil
      }

      let result = current
      current += 1
      return result
    }
  }

  func makeAsyncIterator() -> AsyncIterator {
    return AsyncIterator(howHigh: howHigh)
  }
}
```

<!--
At the call site, using `Counter` would look like this:
-->

在调用方会这么使用 `counter`：

```swift
for await i in Counter(howHigh: 3) {
  print(i)
}

/* 
Prints the following, and finishes the loop:
1
2
3
*/


for await i in Counter(howHigh: 3) {
  print(i)
  if i == 2 { break }
}
/*
Prints the following:
1
2
*/
```

## 具体设计

<!--
Returning to our earlier example:
-->

回到我们之前的例子：

```swift
for try await line in myFile.lines() {
  // Do something with each line
}
```

<!--
The compiler will emit the equivalent of the following code:
-->

编译器将生成类似于下面的代码：

```swift
var it = myFile.lines().makeAsyncIterator()
while let line = try await it.next() {
  // Do something with each line
}
```

<!--
All of the usual rules about error handling apply. For example, this iteration must be surrounded by `do/catch`, or be inside a `throws` function to handle the error. All of the usual rules about `await` also apply. For example, this iteration must be inside a context in which calling `await` is allowed like an `async` function.
-->

所有关于错误处理的常规规则都适用。例如，这个迭代必须被 `do/catch` 包围，或者在 `throws` 函数中处理错误。所有关于 `await` 的常规规则也适用。例如，这个迭代必须在一个允许调用 `await` 的上下文中，就像一个 `async` 函数一样。

### Cancellation

<!--
`AsyncIteratorProtocol` types should use the cancellation primitives provided by Swift's `Task` API, part of [structured concurrency](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md). As described there, the iterator can choose how it responds to cancellation. The most common behaviors will be either throwing `CancellationError` or returning `nil` from the iterator. 
-->

`AsyncIteratorProtocol`类型应该使用 [structured concurrency](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md) 的一部分，Swift 的 `Task` API 提供的"取消"功能。正如那里面所描述的，迭代器可以选择如何响应“取消”。最常见的行为是抛出 `CancellationError` 或者让迭代器返回 `nil`。

<!--
If an `AsyncIteratorProtocol` type has cleanup to do upon cancellation, it can do it in two places:
-->

如果一个 `AsyncIteratorProtocol` 类型在取消时要清理资源，它可以在这两个地方进行：

<!--
1. After checking for cancellation using the `Task` API.
2. In its `deinit` (if it is a class type).
-->

1. 使用 `Task` API 检查是否取消之后。
2. 在其 `deinit` 中（如果它是 class 类型）。

### Rethrows

<!--
This proposal will take advantage of a separate proposal to add specialized `rethrows` conformance in a protocol, pitched [here](https://forums.swift.org/t/pitch-rethrowing-protocol-conformances/42373). With the changes proposed there for `rethrows`, it will not be required to use `try` when iterating an `AsyncSequence` which does not itself throw.
-->

该提案将利用另一项提案，在协议中增加专门的 `rethrows` 一致性，该提案已在[这里](https://forums.swift.org/t/pitch-rethrowing-protocol-conformances/42373)提出。根据该提案对 `rethrows` 的修改，当迭代一个本身不抛出的 `AsyncSequence` 时，将不需要使用 `try`。

<!--
The `await` is always required because the definition of the protocol is that it is always asynchronous.
-->

而 `await` 总是需要有的，因为协议的定义里它总是异步的。

### 结束迭代

<!--
After an `AsyncIteratorProtocol` types returns `nil` or throws an error from its `next()` method, all future calls to `next()` must return `nil`. This matches the behavior of `IteratorProtocol` types and is important, since calling an iterator's `next()` method is the only way to determine whether iteration has finished.
--> 

在 `AsyncIteratorProtocol` 类型的 `next()` 方法返回 `nil` 或抛出错误之后，后续所有对 `next()` 调用都必须返回 `nil`。 与 `IteratorProtocol` 类型的行为保持一致，这很重要，因为调用迭代器的 `next()` 方法是确定迭代是否完成的唯一方法。

## AsyncSequence 函数

<!--
The existence of a standard `AsyncSequence` protocol allows us to write generic algorithms for any type that conforms to it. There are two categories of functions: those that return a single value (and are thus marked as `async`), and those that return a new `AsyncSequence` (and are not marked as `async` themselves).
-->

标准的 `AsyncSequence` 协议的存在使我们能够为任何符合该协议的类型编写通用算法。有两类函数：返回一个单一值的函数（因此被标记为 `async`），和返回一个新的 `AsyncSequence` 的函数（本身没有标记为 `async`）。

<!--
The functions that return a single value are especially interesting because they increase usability by changing a loop into a single `await` line. Functions in this category are `first`, `contains`, `min`, `max`, `reduce`, and more. Functions that return a new `AsyncSequence` include `filter`, `map`, and `compactMap`.
-->

返回单个值的函数特别有趣，因为它们可以将一个循环改为一行 `await`，增加了可用性。例如 `first`、`contains`、`min`、`max`、`reduce` 等。返回一个新的 `AsyncSequence` 的函数有 `filter`、`map`、`compactMap`。

### 将 AsyncSequence 转换为一个值

<!--
Algorithms that reduce a for loop into a single call can improve readability of code. They remove the boilerplate required to set up and iterate a loop.
-->

将 for 循环缩减为一次调用的算法可以提高代码的可读性。它们消除了设置和迭代循环所需的模板。

<!--
For example, here is the `contains` function:
-->

例如，下面是 `contains` 函数：

```swift
extension AsyncSequence where Element : Equatable {
  public func contains(_ value: Element) async rethrows -> Bool
}
```

<!--
With this extension, our "first long line" example from earlier becomes simply:
-->

通过这个扩展，我们前面的"超过 80 个字符的第一行"的例子就可以简化成这样：

```swift
let first = try? await myFile.lines().first(where: { $0.count > 80 })
```

<!--
Or, if the sequence should be processed asynchonously and used later:
-->

或者，如果该序列应该被异步处理并且在之后才会使用：

```swift
async let first = myFile.lines().first(where: { $0.count > 80 })

// later

warnAboutLongLine(try? await first)
```

<!--
The following functions will be added to `AsyncSequence`:
-->

`AsyncSequence` 将增加以下功能：

| 函数 | 备注 |
| --- | --- |
| `contains(_ value: Element) async rethrows -> Bool` | `Element` 需要遵循 `Equatable` |
| `contains(where: (Element) async throws -> Bool) async rethrows -> Bool` | 闭包的 `async` 是可选的 |
| `allSatisfy(_ predicate: (Element) async throws -> Bool) async rethrows -> Bool` | |
| `first(where: (Element) async throws -> Bool) async rethrows -> Element?` | |
| `min() async rethrows -> Element?` | `Element` 需要遵循 `Comparable` |
| `min(by: (Element, Element) async throws -> Bool) async rethrows -> Element?` | |
| `max() async rethrows -> Element?` | `Element` 需要遵循 `Comparable` |
| `max(by: (Element, Element) async throws -> Bool) async rethrows -> Element?` | |
| `reduce<T>(_ initialResult: T, _ nextPartialResult: (T, Element) async throws -> T) async rethrows -> T` | |
| `reduce<T>(into initialResult: T, _ updateAccumulatingResult: (inout T, Element) async throws -> ()) async rethrows -> T` | |

### 将 AsyncSequence 转换为另一个 AsyncSequence

<!--
These functions on `AsyncSequence` return a result which is itself an `AsyncSequence`. Due to the asynchronous nature of `AsyncSequence`, the behavior is similar in many ways to the existing `Lazy` types in the standard library. Calling these functions does not eagerly `await` the next value in the sequence, leaving it up to the caller to decide when to start that work by simply starting iteration when they are ready.
-->

这些关于 `AsyncSequence` 的函数会返回一个结果，这个结果本身就是一个 `AsyncSequence`。由于 `AsyncSequence` 的异步性质，其行为在许多方面与标准库中现有的 `Lazy` 类型相似。调用这些函数并不急于 `await` 序列中的下一个值，而是由调用者决定何时开始该工作，只需在准备好时开始迭代即可。

<!--
As an example, let's look at `map`:
-->

举个例子，让我们看看 `map`：

```swift
extension AsyncSequence {
  public func map<Transformed>(
    _ transform: @escaping (Element) async throws -> Transformed
  ) -> AsyncMapSequence<Self, Transformed>
}

public struct AsyncMapSequence<Upstream: AsyncSequence, Transformed>: AsyncSequence {
  public let upstream: Upstream
  public let transform: (Upstream.Element) async throws -> Transformed
  public struct Iterator : AsyncIterator { 
    public mutating func next() async rethrows -> Transformed?
  }
}
```

<!--
For each of these functions, we first define a type which conforms with the `AsyncSequence` protocol. The name is modeled after existing standard library `Sequence` types like `LazyDropWhileCollection` and `LazyMapSequence`. Then, we add a function in an extension on `AsyncSequence` which creates the new type (using `self` as the `upstream`) and returns it.
-->

对于这种函数，我们首先定义一个符合 `AsyncSequence` 协议的类型，这个名字是仿照现有的标准库 `Sequence` 类型，如 `LazyDropWhileCollection` 和 `LazyMapSequence`。这个名字是仿照现有的标准库 `Sequence` 类型，如 `LazyDropWhileCollection` 和 `LazyMapSequence`。然后，我们在 `AsyncSequence` 上的扩展中添加一个函数，该函数创建新的类型（使用 `self` 作为 `upstream`）并返回。

| 函数 |
| --- |
| `map<T>(_ transform: (Element) async throws -> T) -> AsyncMapSequence` |
| `compactMap<T>(_ transform: (Element) async throws -> T?) -> AsyncCompactMapSequence` |
| `flatMap<SegmentOfResult: AsyncSequence>(_ transform: (Element) async throws -> SegmentOfResult) async rethrows -> AsyncFlatMapSequence` |
| `drop(while: (Element) async throws -> Bool) async rethrows -> AsyncDropWhileSequence` |
| `dropFirst(_ n: Int) async rethrows -> AsyncDropFirstSequence` |
| `prefix(while: (Element) async throws -> Bool) async rethrows -> AsyncPrefixWhileSequence` |
| `prefix(_ n: Int) async rethrows -> AsyncPrefixSequence` |
| `filter(_ predicate: (Element) async throws -> Bool) async rethrows -> AsyncFilterSequence` |

## 未来的改进方向

<!--
The following topics are things we consider important and worth discussion in future proposals:
-->

以下是我们认为重要且值得在今后的提案中讨论的话题：

### 补充更多 `AsyncSequence` 函数

<!--
We've aimed for parity with the most relevant `Sequence` functions. There may be others that are worth adding in a future proposal.
-->

这个提案的目标是与最相关的 `Sequence` 函数保持一致。可能还有其他值得在今后的提案中添加的功能。

<!--
API which uses a time argument must be coordinated with the discussion about `Executor` as part of the [structured concurrency proposal](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md).
-->

使用时间作为参数的 API 必须与[结构化并发提案](https://github.com/apple/swift-evolution/blob/main/proposals/0304-structured-concurrency.md)中的 `Executor` 一起进行讨论。

<!--
We would like a `first` property, but properties cannot currently be `async` or `throws`. Discussions are ongoing about adding a capability to the language to allow effects on properties. If those features become part of Swift then we should add a `first` property to `AsyncSequence`.
-->

我们希望有一个 `first` 属性，但目前 Swift 里的属性不能标记为 `async` 或 `throws`。目前正在讨论在语言中增加一种能力，以允许对属性产生影响。如果这些功能成为了 Swift 的一部分，那么我们应该在 `AsyncSequence` 中添加一个 `first` 属性。

### AsyncSequence Builder

<!--
In the standard library we have not only the `Sequence` and `Collection` protocols, but concrete types which adopt them (for example, `Array`). We will need a similar API for `AsyncSequence` that makes it easy to construct a concrete instance when needed, without declaring a new type and adding protocol conformance.
-->

在标准库中，我们不仅有 `Sequence` 和 `Collection` 协议，还有采用这些协议的具体类型（例如 `Array`）。我们需要为 `AsyncSequence` 提供一个类似的 API，以便在需要的时候很容易地构造一个具体的实例，而不需要声明一个新的类型和增加协议的一致性。

## 代码兼容性

<!--
This new functionality will be source compatible with existing Swift.
-->

这个新功能将与现有的 Swift 代码兼容。

## 对于 ABI 稳定性的影响

<!--
This change is additive to the ABI.
-->

这里的修改是对 ABI 的补充性修改。

## 对于 API 兼容性的影响

<!--
This change is additive to API.
-->

这里的修改是对 API 的补充性修改。

## 其它方案

### 显式 Cancellation

<!--
An earlier version of this proposal included an explicit `cancel` function. We removed it for the following reasons:
-->

该提案的早期版本包括一个明确的 `cancel` 功能。出于以下原因，我们决定将它删除掉：

<!--
1. Reducing the requirements of implementing `AsyncIteratorProtocol` makes it simpler to use and easier to understand. The rules about when `cancel` would be called, while straightforward, would nevertheless be one additional thing for Swift developers to learn.
2. The structured concurrency proposal already includes a definition of cancellation that works well for `AsyncSequence`. We should consider the overall behavior of cancellation for asynchronous code as one concept.
-->

1. 减少实现 `AsyncIteratorProtocol` 的要求，使其更容易使用和理解。关于什么时候调用 `cancel` 的规则，虽然简单明了，但对于 Swift 开发者来说，还是要多学一样东西。
2. 结构化并发提案中已经包含了一个对 `AsyncSequence` 取消的明确定义。我们应该把异步代码的取消行为整体视为一个概念。

### 异步 Cancellation

<!--
If we used explicit cancellation, the `cancel()` function on the iterator could be marked as `async`. However, this means that the implicit cancellation done when leaving a `for/in` loop would require an implicit `await` -- something we think is probably too much to hide from the developer. Most cancellation behavior is going to be as simple as setting a flag to check later, so we leave it as a synchronous function and encourage adopters to make cancellation fast and non-blocking.
-->

如果我们使用显式取消，迭代器的 `cancel()` 函数可以标记为 `async`。然而，这意味着在离开 `for/in` 循环时进行的隐式取消将需要一个隐式的 `await` -- 我们认为这对开发者来说可能太过隐蔽。大多数的取消行为会像设置一个标志以便稍后检查一样简单，所以我们让它作为一个同步函数存在，鼓励采用者让取消行为可以快速执行并且不会阻塞。

### Opaque 类型

<!--
Each `AsyncSequence`-to-`AsyncSequence` algorithm will define its own concrete type. We could attempt to hide these details behind a general purpose type eraser. We believe leaving the types exposed gives us (and the compiler) more optimization opportunities. A great future enhancement would be for the language to support `some AsyncSequence where Element=...`-style syntax, allowing hiding of concrete `AsyncSequence` types at API boundaries.
-->

每个 `AsyncSequence` 到 `AsyncSequence` 的算法都会定义自己的具体类型。我们可以尝试将这些细节隐藏在一个通用的类型擦除器后面。我们相信让类型暴露出来会给我们（和编译器）更多的优化机会。未来的一个潜在的巨大改进是让语言支持 `some AsyncSequence where Element=...` 风格的语法，允许在 API 里隐藏具体的 `AsyncSequence` 类型。

### 复用 Sequence

<!--
If the language supported a `reasync` concept, then it seems plausible that the `AsyncSequence` and `Sequence` APIs could be merged. However, we believe it is still valuable to consider these as two different types. The added complexity of a time dimension in asynchronous code means that some functions need more configuration options or more complex implementations. Some algorithms that are useful on asynchronous sequences are not meaningful on synchronous ones. We prefer not to complicate the API surface of the synchronous collection types in these cases.
-->

如果语言支持 `reasync` 概念，那么 `AsyncSequence` 和 `Sequence` API 合并起来似乎是合理的。然而，我们认为，将其视为两种不同的类型仍然是有价值的。异步代码中增加了时间维度的复杂性，这意味着一些函数需要更多的配置选项或更复杂的实现。一些在异步序列上有用的算法在同步序列上是没有意义的。在这些情况下，我们最好不要让同步集合类型的 API 复杂化。

### 命名

<!--
The names of the concrete `AsyncSequence` types is designed to mirror existing standard library API like `LazyMapSequence`. Another option is to introduce a new pattern with an empty enum or other namespacing mechanism.
-->

具体的 `AsyncSequence` 类型的名称被设计为镜像现有的标准库 API，如 `LazyMapSequence`。另一种选择是用一个空的枚举或其他命名机制引入一个新的模式。

<!--
We considered `AsyncGenerator` but would prefer to leave the `Generator` name for future language enhancements. `Stream` is a type in Foundation, so we did not reuse it here to avoid confusion.
-->

我们考虑过 `AsyncGenerator`，但希望保留 `Generator` 这个名称给后续的功能实用。`Stream` 是Foundation 中的一个类型，因此我们没有在这里重复使用，避免混淆。

### `await in`

<!--
We considered a shorter syntax of `await...in`. However, since the behavior here is fundamentally a loop, we feel it is important to use the existing `for` keyword as a strong signal of intent to readers of the code. Although there are a lot of keywords, each one has purpose and meaning to readers of the code.
-->

我们考虑过一个更短的 `await...in` 的语法。然而，由于这里的行为从根本上说是一个循环，我们认为必须使用现有的 `for` 关键字作为对代码读者的强烈信号。虽然有很多关键字，但它们每一个关键字对代码的读者来说都有目的和意义。

### 添加 API 到 Iterator 里（而不是 Sequence）

<!--
We discussed applying the fundamental API (`map`, `reduce`, etc.) to `AsyncIteratorProtocol` instead of `AsyncSequence`. There has been a long-standing (albeit deliberate) ambiguity in the `Sequence` API -- is it supposed to be single-pass or multi-pass? This new kind of iterator & sequence could provide an opportunity to define this more concretely.
-->

我们讨论了将基本 API(`map`、`reduce` 等)应用于 `AsyncIteratorProtocol` 而不是 `AsyncSequence`。在 `Sequence` API 中一直存在着一个长期的（虽然是故意的）歧义 -- 它到底应该是一次还是多次循环？这个新的迭代器和序列提供了一个更具体地定义这个问题的机会。

<!--
While it is tempting to use this new API to right past wrongs, we maintain that the high level goal of consistency with existing Swift concepts is more important. 
-->

虽然很想用这个新的API来纠正过去的错误，但我们认为，与现有 Swift 概念保持一致的原则性目标更为重要。

<!--
For example, `for...in` cannot be used on an `IteratorProtocol` -- only a `Sequence`. If we chose to make `AsyncIteratorProtocol` use `for...in` as described here, that leaves us with the choice of either introducing an inconsistency between `AsyncIteratorProtocol` and `IteratorProtocol` or giving up on the familiar `for...in` syntax. Even if we decided to add `for...in` to `IteratorProtocol`, it would still be inconsistent because we would be required to leave `for...in` syntax on the existing `Sequence`.
-->

例如，`for...in` 不能用于 `IteratorProtocol` -- 只能用于 `Sequence`。如果我们选择让 `AsyncIteratorProtocol` 使用这里描述的 `for...in`，那我们就只能选择在 `AsyncIteratorProtocol` 和 `IteratorProtocol` 之间引入不一致的行为，或者放弃熟悉的 `for...in` 语法。即使我们决定在 `IteratorProtocol` 中加入 `for...in`，它仍然是不一致的，因为我们需要在现有的 `Sequence` 上留下 `for...in` 语法。

<!--
Another point in favor of consistency is that implementing an `AsyncSequence` should feel familiar to anyone who knows how to implement a `Sequence`.
-->

倾向于保持一致性的另一个原因是，实现 `AsyncSequence` 对于任何知道如何实现 `Sequence` 的人来说都会感到熟悉。

<!--
We are hoping for widespread adoption of the protocol in API which would normally have instead used a `Notification`, informational delegate pattern, or multi-callback closure argument. In many of these cases we feel like the API should return the 'factory type' (an `AsyncSequence`) so that it can be iterated again. It will still be up to the caller to be aware of any underlying cost of performing that operation, as with iteration of any `Sequence` today.
-->

我们希望在 API 中广泛采用该协议，通常情况下，API 会使用 `Notification`、delegate 或者回调。在大部分这样的情况下，我们觉得 API 应该返回 "工厂类型"（一个 `AsyncSequence`），以便它可以再次迭代。调用者仍然需要知道执行该操作的任何基本成本，就像今天任何 `Sequence` 的迭代一样。