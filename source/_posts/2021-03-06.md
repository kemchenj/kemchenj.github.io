---
title: 【译】SE-0296 Async/await
date: 2021-03-06
---

> 原文链接：[SE-0296 async/await](https://github.com/apple/swift-evolution/blob/main/proposals/0296-async-await.md)

* Proposal: [SE-0296](https://github.com/apple/swift-evolution/blob/main/proposals/0296-async-await.md)
* Authors: [John McCall](https://github.com/rjmccall), [Doug Gregor](https://github.com/DougGregor)
* Review Manager: [Ben Cohen](https://github.com/airspeedswift)
* Status: **Implemented (Swift 5.5)**
* Implementation: Available in [recent `main` snapshots](https://swift.org/download/#snapshots) behind the flag `-Xfrontend -enable-experimental-concurrency`
* Decision Notes: [Rationale](https://forums.swift.org/t/accepted-with-modification-se-0296-async-await/43318)

<!--
Table of Contents
=================

   * [Async/await](#asyncawait)
      * [Introduction](#introduction)
      * [Motivation: Completion handlers are suboptimal](#motivation-completion-handlers-are-suboptimal)
      * [Proposed solution: async/await](#proposed-solution-asyncawait)
         * [Suspension points](#suspension-points)
      * [Detailed design](#detailed-design)
         * [Asynchronous functions](#asynchronous-functions)
         * [Asynchronous function types](#asynchronous-function-types)
         * [Await expressions](#await-expressions)
         * [Closures](#closures)
         * [Overloading and overload resolution](#overloading-and-overload-resolution)
         * [Autoclosures](#autoclosures)
         * [Protocol conformance](#protocol-conformance)
      * [Source compatibility](#source-compatibility)
      * [Effect on ABI stability](#effect-on-abi-stability)
      * [Effect on API resilience](#effect-on-api-resilience)
      * [Future Directions](#future-directions)
         * [reasync](#reasync)
      * [Alternatives Considered](#alternatives-considered)
         * [Make await imply try](#make-await-imply-try)
         * [Launching async tasks](#launching-async-tasks)
         * [Await as syntactic sugar](#await-as-syntactic-sugar)
      * [Revision history](#revision-history)
      * [Related proposals](#related-proposals)
      * [Acknowledgments](#acknowledgments)
-->

## 简介

<!--
Modern Swift development involves a lot of asynchronous (or "async") programming using closures and completion handlers, but these APIs are hard to use.  This gets particularly problematic when many asynchronous operations are used, error handling is required, or control flow between asynchronous calls gets complicated.  This proposal describes a language extension to make this a lot more natural and less error prone.
-->

现代 Swift 开发涉及大量使用闭包和回调的异步编程，但这些 API 很难使用。当使用了许多异步操作，需要错误处理，或者异步调用之间的控制流变得复杂时，这就变得特别麻烦。这个提案描述了一种语言扩展，使之更自然，更不容易出错。

<!--
This design introduces a [coroutine model](https://en.wikipedia.org/wiki/Coroutine) to Swift. Functions can opt into being `async`, allowing the programmer to compose complex logic involving asynchronous operations using the normal control-flow mechanisms. The compiler is responsible for translating an asynchronous function into an appropriate set of closures and state machines.
-->

这份设计将 [coroutine模型](https://en.wikipedia.org/wiki/Coroutine)引入 Swift。函数可以选择成为 `async`，允许程序员使用正常的控制流机制来编写涉及异步操作的复杂逻辑。编译器负责将一个异步函数翻译成一套适当的闭包和状态机。

<!--
This proposal defines the semantics of asynchronous functions. However, it does not provide concurrency: that is covered by a separate proposal to introduce structured concurrency, which associates asynchronous functions with concurrently-executing tasks and provides APIs for creating, querying, and cancelling tasks.
-->

这个提案定义了异步函数的语义。然而，它并没有提供并发性：这在另一个引入结构化并发的提案里讨论，该提案将异步函数与并发执行的任务联系起来，并提供用于创建、查询和取消任务的 API。

Swift-evolution thread: [Pitch #1](https://forums.swift.org/t/concurrency-asynchronous-functions/41619), [Pitch #2](https://forums.swift.org/t/pitch-2-async-await/42420)

<!--more-->

## 动机：闭包不是最理想的解决方案

<!--
Async programming with explicit callbacks (also called completion handlers) has many problems, which we’ll explore below.  We propose to address these problems by introducing async functions into the language.  Async functions allow asynchronous code to be written as straight-line code.  They also allow the implementation to directly reason about the execution pattern of the code, allowing callbacks to run far more efficiently.
-->

使用显式回调的异步编程有很多问题，我们将在下面探讨这些问题。我们建议通过在语言中引入 `async` 函数来解决这些问题。`async` 函数允许将异步代码写成线性代码。它们还允许直接推导代码的执行模式，使回调的运行效率大大提高。

#### 问题 1：回调地狱

<!--
A sequence of simple asynchronous operations often requires deeply-nested closures. Here is a made-up example showing this:
-->

想要把简单的异步操作串联起来往往需要嵌套多层闭包。下面举一个例子：

```swift
func processImageData1(completionBlock: (_ result: Image) -> Void) {
    loadWebResource("dataprofile.txt") { dataResource in
        loadWebResource("imagedata.dat") { imageResource in
            decodeImage(dataResource, imageResource) { imageTmp in
                dewarpAndCleanupImage(imageTmp) { imageResult in
                    completionBlock(imageResult)
                }
            }
        }
    }
}

processImageData1 { image in
    display(image)
}
```

<!--
This "pyramid of doom" makes it difficult to read and keep track of where the code is running. In addition, having to use a stack of closures leads to many second order effects that we will discuss next.
-->

这种“回调地狱”使得我们很难读取和跟踪代码运行的位置。此外，不得不使用闭包嵌套会导致许多副作用，我们将在接下来讨论。

#### 问题 2：错误处理

<!--
Callbacks make error handling difficult and very verbose. Swift 2 introduced an error handling model for synchronous code, but callback-based interfaces do not derive any benefit from it:
-->

回调使错误处理变得困难且非常啰嗦。Swift 2 为同步代码引入了一个错误处理模型，但基于回调的接口并没有从中得到任何好处:

```swift
// (2a) Using a `guard` statement for each callback:
func processImageData2a(completionBlock: (_ result: Image?, _ error: Error?) -> Void) {
    loadWebResource("dataprofile.txt") { dataResource, error in
        guard let dataResource = dataResource else {
            completionBlock(nil, error)
            return
        }
        loadWebResource("imagedata.dat") { imageResource, error in
            guard let imageResource = imageResource else {
                completionBlock(nil, error)
                return
            }
            decodeImage(dataResource, imageResource) { imageTmp, error in
                guard let imageTmp = imageTmp else {
                    completionBlock(nil, error)
                    return
                }
                dewarpAndCleanupImage(imageTmp) { imageResult, error in
                    guard let imageResult = imageResult else {
                        completionBlock(nil, error)
                        return
                    }
                    completionBlock(imageResult)
                }
            }
        }
    }
}

processImageData2a { image, error in
    guard let image = image else {
        display("No image today", error)
        return
    }
    display(image)
}
```

<!--
The addition of [`Result`](https://github.com/apple/swift-evolution/blob/main/proposals/0235-add-result.md) to the standard library improved on error handling for Swift APIs. Asynchronous APIs were one of the [main motivators](https://github.com/apple/swift-evolution/blob/main/proposals/0235-add-result.md#asynchronous-apis) for `Result`: 
-->

[`Result`](https://github.com/apple/swift-evolution/blob/main/proposals/0235-add-result.md) 加入标准库主要是为了改善 Swift API 的错误处理，而异步 API 是 `Result` 提案[想要优化](https://github.com/apple/swift-evolution/blob/main/proposals/0235-add-result.md#asynchronous-apis)的其中一部分：

```swift
// (2b) Using a `do-catch` statement for each callback:
func processImageData2b(completionBlock: (Result<Image, Error>) -> Void) {
    loadWebResource("dataprofile.txt") { dataResourceResult in
        do {
            let dataResource = try dataResourceResult.get()
            loadWebResource("imagedata.dat") { imageResourceResult in
                do {
                    let imageResource = try imageResourceResult.get()
                    decodeImage(dataResource, imageResource) { imageTmpResult in
                        do {
                            let imageTmp = try imageTmpResult.get()
                            dewarpAndCleanupImage(imageTmp) { imageResult in
                                completionBlock(imageResult)
                            }
                        } catch {
                            completionBlock(.failure(error))
                        }
                    }
                } catch {
                    completionBlock(.failure(error))
                }
            }
        } catch {
            completionBlock(.failure(error))
        }
    }
}

processImageData2b { result in
    do {
        let image = try result.get()
        display(image)
    } catch {
        display("No image today", error)
    }
}
```

```swift
// (2c) Using a `switch` statement for each callback:
func processImageData2c(completionBlock: (Result<Image, Error>) -> Void) {
    loadWebResource("dataprofile.txt") { dataResourceResult in
        switch dataResourceResult {
        case .success(let dataResource):
            loadWebResource("imagedata.dat") { imageResourceResult in
                switch imageResourceResult {
                case .success(let imageResource):
                    decodeImage(dataResource, imageResource) { imageTmpResult in
                        switch imageTmpResult {
                        case .success(let imageTmp):
                            dewarpAndCleanupImage(imageTmp) { imageResult in
                                completionBlock(imageResult)
                            }
                        case .failure(let error):
                            completionBlock(.failure(error))
                        }
                    }
                case .failure(let error):
                    completionBlock(.failure(error))
                }
            }
        case .failure(let error):
            completionBlock(.failure(error))
        }
    }
}

processImageData2c { result in
    switch result {
    case .success(let image):
        display(image)
    case .failure(let error):
        display("No image today", error)
    }
}
```

<!--
It's easier to handle errors when using `Result`, but the closure-nesting problem remains.
-->

使用 `Result` 可以简化错误处理，但闭包嵌套的问题依然存在。

#### 问题3：选择性执行很难并且容易出错

<!--
Conditionally executing an asynchronous function is a huge pain. For example, suppose we need to "swizzle" an image after obtaining it. But, we sometimes have to make an asynchronous call to decode the image before we can swizzle. Perhaps the best approach to structuring this function is to write the swizzling code in a helper "continuation" closure that is conditionally captured in a completion handler, like this:
-->

选择性执行一个异步函数是一件非常痛苦的事情。例如，假设我们需要在获取到图像后进行 `swizzle`，但是，我们有时候不得不在 `swizzle` 之前触发异步调用去解码图片。也许这个函数最好的结构是使用一个 helper "continuation" 闭包，在回调的闭包里捕获它，就像这样：

```swift
func processImageData3(recipient: Person, completionBlock: (_ result: Image) -> Void) {
    let swizzle: (_ contents: Image) -> Void = {
      // ... continuation closure that calls completionBlock eventually
    }
    if recipient.hasProfilePicture {
        swizzle(recipient.profilePicture)
    } else {
        decodeImage { image in
            swizzle(image)
        }
    }
}
```

<!--
This pattern inverts the natural top-down organization of the function: the code that will execute in the second half of the function must appear *before* the part that executes in the first half. In addition to restructuring the entire function, we must now think carefully about captures in the continuation closure, because the closure is used in a completion handler. The problem worsens as the number of conditionally-executed async functions grows, yielding what is essentially an inverted "pyramid of doom."
-->

这种模式颠倒了自上而下的自然函数结构：函数下半部才会执行的代码必须在上半部执行*之前*出现。为了重构这整个函数，我们必须小心地思考闭包里捕获的东西，因为这个闭包会在回调里被捕获。这个问题会随着选择性执行的异步函数越来越多变得越来越严重，最终会成为一个反转的回调地狱。

#### 问题4：很容易造成很多错误

<!--
It's quite easy to bail-out of the asynchronous operation early by simply returning without calling the correct completion-handler block. When forgotten, the issue is very hard to debug:
-->

异步操作提前退出时很容易忘记调用回调。忘记这件事的时候，问题就会很难 debug：

```swift
func processImageData4a(completionBlock: (_ result: Image?, _ error: Error?) -> Void) {
    loadWebResource("dataprofile.txt") { dataResource, error in
        guard let dataResource = dataResource else {
            return // <- forgot to call the block
        }
        loadWebResource("imagedata.dat") { imageResource, error in
            guard let imageResource = imageResource else {
                return // <- forgot to call the block
            }
            ...
        }
    }
}
```

<!--
When you do remember to call the block, you can still forget to return after that:
-->

当你记得调用闭包时，你还有可能忘记在这之后 return：

```swift
func processImageData4b(recipient:Person, completionBlock: (_ result: Image?, _ error: Error?) -> Void) {
    if recipient.hasProfilePicture {
        if let image = recipient.profilePicture {
            completionBlock(image) // <- forgot to return after calling the block
        }
    }
    ...
}
```

<!--
Thankfully the `guard` syntax protects against forgetting to return to some degree, but it's not always relevant.
-->

还好 `guard` 语法会在一定程度上防止你忘记 return 的事情，但它不能解决所有问题。

#### 问题 5：因为回调很难用，很多 API 会设计成同步阻塞的形式

<!--
This is hard to quantify, but the authors believe that the awkwardness of defining and using asynchronous APIs (using completion handlers) has led to many APIs being defined with apparently synchronous behavior, even when they can block.  This can lead to problematic performance and responsiveness problems in UI applications, e.g. a spinning cursor.  It can also lead to the definition of APIs that cannot be used when asynchrony is critical to achieve scale, e.g. on the server.
-->

这很难量化，但作者认为，定义和使用异步 API（使用完成处理程序）的尴尬导致许多 API 被定义为明显的同步行为，即使它们会产生阻塞。这可能会导致 UI 应用程序的性能和响应性问题，例如旋转的光标。它还可能导致定义的 API 在异步对水平拓展至关重要时无法使用，例如在服务器上。

## 解决方案：async/await

<!--
Asynchronous functions—often known as async/await—allow asynchronous code to be written as if it were straight-line, synchronous code.  This immediately addresses many of the problems described above by allowing programmers to make full use of the same language constructs that are available to synchronous code.  The use of async/await also naturally preserves the semantic structure of the code, providing information necessary for at least three cross-cutting improvements to the language: (1) better performance for asynchronous code; (2) better tooling to provide a more consistent experience while debugging, profiling, and exploring code; and (3) a foundation for future concurrency features like task priority and cancellation.  The example from the prior section demonstrates how async/await drastically simplifies asynchronous code:
-->

异步函数 - 通常被称为 async/await - 允许将异步代码当作线性同步代码来编写。这就立马解决了上述的许多问题，因为它允许程序员充分利用与同步代码相同的语言结构。使用 async/await 还自然地保留了代码的语义结构，提供了必要的信息让语言可以做至少三个方向的改进。(1) 为异步代码提供更好的性能；(2) 更好的工具，在调试、剖析和探索代码时提供更一致的体验；(3) 为未来的并发特性（如任务优先级和取消）奠定基础。上一节的例子可以展示 async/await 如何大幅简化异步代码：

```swift
func loadWebResource(_ path: String) async throws -> Resource
func decodeImage(_ r1: Resource, _ r2: Resource) async throws -> Image
func dewarpAndCleanupImage(_ i : Image) async throws -> Image

func processImageData() async throws -> Image {
  let dataResource  = try await loadWebResource("dataprofile.txt")
  let imageResource = try await loadWebResource("imagedata.dat")
  let imageTmp      = try await decodeImage(dataResource, imageResource)
  let imageResult   = try await dewarpAndCleanupImage(imageTmp)
  return imageResult
}
```

许多关于 async/await 的描述讨论了一个通用的实现机制：一个将函数拆分为多个组件的编译器 pass。这对于底层抽象来说很重要，为了理解机器如何执行，但在更高的层次，我们更鼓励你忽略它。相反，把异步函数看成一个普通函数，只是具有放弃其线程的特殊权利。异步函数通常不会直接使用这个权力；相反，它们产生调用，有时这些调用会要求它们放弃自己的线程，等待某件事情的发生。当这个事情完成后，函数会再次恢复执行。

<!--
The analogy with synchronous functions is very strong.  A synchronous function can make a call; when it does, the function immediately waits for the call to complete. Once the call completes, control returns to the function and picks up where it left off.  The same thing is true with an asynchronous function: it can make calls as usual; when it does, it (normally) immediately waits for the call to complete. Once the call completes, control returns to the function and it picks up where it was.  The only difference is that synchronous functions get to take full advantage of (part of) their thread and its stack, whereas *asynchronous functions are able to completely give up that stack and use their own, separate storage*.  This additional power given to asynchronous functions has some implementation cost, but we can reduce that quite a bit by designing holistically around it.
-->

与同步函数对比非常明显。一个同步函数可以进行调用；当它调用时，函数立即等待调用完成。一旦调用完成，控制权就会返回到函数，并从它离开的地方开始。异步函数也是如此：它可以像往常一样进行调用；当它进行调用时，它（通常）立即等待调用完成。一旦调用完成，控制权就会回到函数，它就会回到原来的位置。唯一的区别是，同步函数可以充分利用（部分）它的线程和它的栈，而*异步函数则可以完全放弃这个栈，使用自己的、独立的存储*。这种赋予异步函数的额外权力有一定的实现成本，但我们可以通过围绕它进行整体设计来降低不少成本。

<!--
Because asynchronous functions must be able to abandon their thread, and synchronous functions don’t know how to abandon a thread, a synchronous function can’t ordinarily call an asynchronous function: the asynchronous function would only be able to give up the part of the thread it occupied, and if it tried, its synchronous caller would treat it like a return and try to pick up where it was, only without a return value.  The only way to make this work in general would be to block the entire thread until the asynchronous function was resumed and completed, and that would completely defeat the purpose of asynchronous functions, as well as having nasty systemic effects.
-->

因为异步函数必须能够放弃自己的线程，而同步函数不知道如何放弃一个线程，所以一个同步函数通常不能调用一个异步函数：异步函数只能放弃它所占用的那部分线程，如果它试图放弃，它的同步调用者就会把它当作一个返回，并试图拾起原来的位置，只是没有返回值。在一般情况下，唯一的办法就是阻塞整个线程，直到异步函数被恢复并完成，但这将完全违背异步函数的目的，同时也会产生恶劣的系统影响。

<!--
In contrast, an asynchronous function can call either synchronous or asynchronous functions.  While it’s calling a synchronous function, of course, it can’t give up its thread.  In fact, asynchronous functions never just spontaneously give up their thread; they only give up their thread when they reach what’s called a suspension point.  A suspension point can occur directly within a function, or it can occur within another asynchronous function that the function calls, but in either case the function and all of its asynchronous callers simultaneously abandon the thread.  (In practice, asynchronous functions are compiled to not depend on the thread during an asynchronous call, so that only the innermost function needs to do any extra work.)
-->

而异步函数则可以调用同步函数或异步函数。当然，当它在调用同步函数时，它不能放弃自己的线程。事实上，异步函数从来不会自发地放弃自己的线程，只有当它达到所谓的 suspension point 时才会放弃自己的线程。suspension point 可以直接发生在一个函数中，也可以发生在该函数调用的另一个异步函数中，但无论哪种情况，该函数及其所有异步调用者都会同时放弃该线程。(实际上，异步函数在异步调用过程中都会被编译成不依赖于线程，因此只有最内部的函数需要做任何额外的工作)。

<!--
When control returns to an asynchronous function, it picks up exactly where it was.  That doesn’t necessarily mean that it’ll be running on the exact same thread it was before, because the language doesn’t guarantee that after a suspension.  In this design, threads are mostly an implementation mechanism, not a part of the intended interface to concurrency.  However, many asynchronous functions are not just asynchronous: they’re also associated with specific actors (which are the subject of a separate proposal), and they’re always supposed to run as part of that actor.  Swift does guarantee that such functions will in fact return to their actor to finish executing.  Accordingly, libraries that use threads directly for state isolation—for example, by creating their own threads and scheduling tasks sequentially onto them—should generally model those threads as actors in Swift in order to allow these basic language guarantees to function properly.
-->

当控制返回到一个异步函数时，它就会从原来的地方拾起。这并不意味着它一定会在和之前完全相同的线程上运行，因为语言并不能保证在 suspension 后会这样。在这种设计中，线程主要是一种实现机制，而不是并发的预设接口的一部分。然而，许多异步函数并不仅仅是异步的：它们还与特定的 actor 相关联（这是一个单独提案的主题），而且它们总是应该作为该 actor 的一部分运行。Swift 确实保证这类函数事实上会返回到它们的 actor 中去完成执行。相应地，直接使用线程进行状态隔离的库--例如，通过创建自己的线程并将任务按顺序调度到线程上--一般应该将这些线程建模为 Swift 里的 actor，以便这些基本的语言保证能够正常运行。

### Suspension point 

<!--
A suspension point is a point in the execution of an asynchronous function where it has to give up its thread.  Suspension points are always associated with some deterministic, syntactically explicit event in the function; they’re never hidden or asynchronous from the function’s perspective.  The primary form of suspension point is a call to an asynchronous function associated with a different execution context.
-->

Suspension point 是异步函数执行过程中不得不放弃其线程的一个点。Suspension point 总是与函数中的一些确定性的、语法上显式的事件相关联；从函数的角度来看，它们从来都不是隐藏的或异步的。Suspension point 的主要形式是调用一个与不同执行上下文相关联的异步函数。

<!--
It is important that suspension points are only associated with explicit operations.  In fact, it’s so important that this proposal requires that calls that *might* suspend be enclosed in an `await` expression. These calls are referred to as *potential suspension points*, because it is not known statically whether they will actually suspend: that depends both on code not visible at the call site (e.g., the callee might depend on asynchronous I/O) as well as dynamic conditions (e.g., whether that asynchronous I/O will have to wait to complete). 
-->

重要的是，suspension point 只与显式操作相关联。事实上，这一点非常重要，以至于该提案要求将*可能* suspend 的调用用 `await` 表达式修饰。这些调用被称为*潜在的 suspension point*，因为静态分析时并不知道它们是否真的会 suspend：这既取决于调用方不可见的代码（例如，被调用者可能依赖于异步 I/O），也取决于动态条件（例如，该异步 I/O是否需要等待才能完成）。

<!--
The requirement for `await` on potential suspension points follows Swift's precedent of requiring `try` expressions to cover calls to functions that can throw errors. Marking potential suspension points is particularly important because *suspensions interrupt atomicity*.  For example, if an asynchronous function is running within a given context that is protected by a serial queue, reaching a suspension point means that other code can be interleaved on that same serial queue.  A classic but somewhat hackneyed example where this atomicity matters is modeling a bank: if a deposit is credited to one account, but the operation suspends before processing a matched withdrawal, it creates a window where those funds can be double-spent.  A more germane example for many Swift programmers is a UI thread: the suspension points are the points where the UI can be shown to the user, so programs that build part of their UI and then suspend risk presenting a flickering, partially-constructed UI.  (Note that suspension points are also called out explicitly in code using explicit callbacks: the suspension happens between the point where the outer function returns and the callback starts running.)  Requiring that all potential suspension points are marked allows programmers to safely assume that places without potential suspension points will behave atomically, as well as to more easily recognize problematic non-atomic patterns.
-->

对潜在的 suspension point 的 `await` 要求延续 Swift 的之前的做法，要求 `try` 表达式涵盖对可能抛出错误的函数的调用。标记潜在的 suspension point 特别重要，因为 *suspension 会中断原子性*。例如，如果一个异步函数在一个给定的上下文中运行，而这个上下文是由一个串行队列保护的，那么达到一个suspension point 就意味着其他代码可以在同一个串行队列上插入其它代码。一个经典但有点老套的例子，这种原子性很重要，那就是对银行账户进行建模：如果一笔存款被记入一个账户，但在处理匹配的取款之前，操作 suspend，就会产生一个窗口期，在这个窗口期中，这些资金可以被重复使用。对于很多 Swift 程序员来说，一个更贴切的例子是 UI 线程：suspension point 是 UI 可以展示给用户的点，所以程序如果构建了部分 UI，然后 suspend，就有可能呈现出一个闪烁的、构建了一半的 UI。(请注意，在使用显式回调的代码中，suspension point也是显式调用的：suspend 会发生在外部函数返回和回调开始运行的点之间)。要求对所有潜在的 suspension point 进行标记，可以让程序员安全地假设没有潜在 suspension point 的地方将表现为原子模式，以及更容易识别有问题的非原子模式。

<!--
Because potential suspension points can only appear at points explicitly marked within an asynchronous function, long computations can still block threads.  This might happen when calling a synchronous function that just does a lot of work, or when encountering a particularly intense computational loop written directly in an asynchronous function.  In either case, the thread cannot interleave code while these computations are running, which is usually the right choice for correctness, but can also become a scalability problem.  Asynchronous programs that need to do intense computation should generally run it in a separate context.  When that’s not feasible, there will be library facilities to artificially suspend and allow other operations to be interleaved.
-->

因为潜在的 suspension point 只能出现在异步函数中明确标记的位置，所以长时间的计算仍然会阻塞线程。这种情况可能发生在调用一个只是做了很多工作的同步函数时，或者遇到直接写在异步函数中的特别密集的计算循环时。无论是哪种情况，在这些计算运行的时候，线程都不能在中间插入其它运算逻辑，这通常是正确性的正确选择，但也可能成为一个扩展性问题。需要进行高强度计算的异步程序一般应该在一个单独的上下文中运行。当这不可行时，会有第三方库的设施人为地 suspend 并允许其他操作插入执行。

<!--
Asynchronous functions should avoid calling functions that can actually block the thread, especially if they can block it waiting for work that’s not guaranteed to be currently running.  For example, acquiring a mutex can only block until some currently-running thread gives up the mutex; this is sometimes acceptable but must be used carefully to avoid introducing deadlocks or artificial scalability problems.  In contrast, waiting on a condition variable can block until some arbitrary other work gets scheduled that signals the variable; this pattern goes strongly against recommendation.
-->

异步函数应该避免调用实际上可以阻塞线程的函数，特别是当它们可以阻塞线程，等待那些不能保证当前正在运行的工作时。例如，获取一个互斥锁时只能阻塞，直到某个当前正在运行的线程放弃互斥锁；这有时是可以接受的，但必须谨慎使用，以避免引入死锁或人为的可扩展性问题。相反，在一个条件变量上的等待可以阻塞，直到一些任意的其他工作得到安排，给变量发出信号；这种模式与建议强烈相悖。

## 设计细节

### 异步函数

<!--
Function types can be marked explicitly as `async`, indicating that the function is asynchronous:
-->

函数类型可以明确标记为 `async`，表示该函数是异步的：

```swift
func collect(function: () async -> Int) { ... }
```

<!--
A function or initializer declaration can also be declared explicitly as `async`:
-->

一个函数或初始化器声明也可以显式声明为 `async`：

```swift
class Teacher {
  init(hiringFrom: College) async throws {
    ...
  }
  
  private func raiseHand() async -> Bool {
    ...
  }
}
```

<!--
> **Rationale**: The `async` follows the parameter list because it is part of the function's type as well as its declaration. This follows the precedent of `throws`.
-->

> **理由**：`async` 跟在参数列表后面，因为它既是函数类型的一部分，也是函数声明的一部分。这遵循了 `throws` 的先例。

<!--
The type of a reference to a function or initializer declared `async` is an `async` function type. If the reference is a “curried” static reference to an instance method, it is the "inner" function type that is `async`, consistent with the usual rules for such references.
-->

声明为 `async` 的函数或构造器的引用，类型是 `async` 函数类型。如果该引用是对实例方法的 "curried" 静态引用，则按照此类引用的通常规则，"内部"函数类型为`async`。

<!--
Special functions like `deinit` and storage accessors (i.e., the getters and setters for properties and subscripts) cannot be `async`.
-->

像 `deinit` 和存储访问器这样的特殊函数（例如，属性的 getter/setter 和 subscript）不能为 `async`。

<!--
> **Rationale**: Properties and subscripts that only have a getter could potentially be `async`. However, properties and subscripts that also have an `async` setter imply the ability to pass the reference as `inout` and drill down into the properties of that property itself, which depends on the setter effectively being an "instantaneous" (synchronous, non-throwing) operation. Prohibiting `async` properties is a simpler rule than only allowing get-only `async` properties and subscripts.
-->

> **理由**：只有 getter 的属性和  subscript 可以是 `async` 的。然而，`async` setter 的属性和下标意味着能够将引用作为 `inout` 传递，并深入到该属性本身的属性，这取决于 setter 实际上是否为一个"瞬时"（同步、non-throwing）操作。比起只允许 `async` get-only 的属性和 subscript，禁止 `async` 属性是更简单的规则。
 
<!--
If a function is both `async` and `throws`, then the `async` keyword must precede `throws` in the type declaration. This same rule applies if `async` and `rethrows`.
-->

如果一个函数既是 `async` 又是 `throws` 的，那么在类型声明中，`async` 关键字就必须放在 `throws` 前面。这个规则同样适用于 `async` 和 `rethrows`。

<!--
> **Rationale** : This order restriction is arbitrary, but it's not harmful, and it eliminates the potential for stylistic debates.
-->

> **理由**：这个顺序限制是随性的，但并不会带来害处，而且以后也不需要去争辩该用哪种代码风格。

<!--
An `async` initializer of a class that has a superclass but lacks a call to a superclass initializer will get an implicit call to `super.init()` only if the superclass has a zero-argument, synchronous, designated initializer.
-->

一个有父类但没有调用父类构造器的 `async` 构造器，只有当超类有一个零参数的、同步的、指定的初始化器时，才会得到对`super.init()`的隐式调用。

<!--
> **Rationale**: If the superclass initializer is `async`, the call to the asynchronous initializer is a potential suspension point and therefore the call (and required `await`) must be visible in the source.
-->

> **理由**：如果超类初始化器是 `async`，对异步构造器的调用就是一个潜在的 suspension point，因此，调用(和所需的 `await`)必须在代码里可见。

### 异步函数类型

<!--
Asynchronous function types are distinct from their synchronous counterparts. However, there is an implicit conversion from a synchronous function type to its corresponding asynchronous function type. This is similar to the implicit conversion from a non-throwing function to its throwing counterpart, which can also compose with the asynchronous function conversion. For example:
-->

异步函数的类型明显与同步函数的类型不同。然而，从同步函数的类型到其对应的异步函数的类型会有一个自动隐式转换。这类似于从一个 non-throwing 函数到其 throwing 对应函数的隐式转换，也可以与异步函数转换组合到一起。例如：

```swift
struct FunctionTypes {
  var syncNonThrowing: () -> Void
  var syncThrowing: () throws -> Void
  var asyncNonThrowing: () async -> Void
  var asyncThrowing: () async throws -> Void
  
  mutating func demonstrateConversions() {
    // Okay to add 'async' and/or 'throws'    
    asyncNonThrowing = syncNonThrowing
    asyncThrowing = syncThrowing
    syncThrowing = syncNonThrowing
    asyncThrowing = asyncNonThrowing
    
    // Error to remove 'async' or 'throws'
    syncNonThrowing = asyncNonThrowing // error
    syncThrowing = asyncThrowing       // error
    syncNonThrowing = syncThrowing     // error
    asyncNonThrowing = syncThrowing    // error
  }
}
```

### await 表达式

<!--
A call to a value of `async` function type (including a direct call to an `async` function) introduces a potential suspension point. Any potential suspension point must occur within an asynchronous context (e.g., an `async` function). Furthermore, it must occur within the operand of an `await` expression. 
-->

对 `async` 函数的调用（包括对 `async` 函数的直接调用）会引入一个潜在的 suspension point。任何潜在的 suspension point 必须发生在异步上下文中（例如，一个 `async` 函数）。此外，它必须发生在 `await` 表达式的对象内。

请看下面的例子：

```swift
// func redirectURL(for url: URL) async -> URL { ... }
// func dataTask(with: URL) async throws -> (Data, URLResponse) { ... }

let newURL = await server.redirectURL(for: url)
let (data, response) = try await session.dataTask(with: newURL)
```

<!--
In this code example, a task suspension may happen during the calls to `redirectURL(for:)` and `dataTask(with:)` because they are async functions. Thus, both call expressions must be contained within some `await` expression, because each call contains a potential suspension point. An `await` operand may contain more than one potential suspension point. For example, we can use one `await` to cover both potential suspension points from our example by rewriting it as:
-->

在这个代码示例中，在调用 `redirectURL(for:)` 和 `dataTask(with:)` 期间可能会发生任务suspension，因为它们是异步函数。因此，这两个调用表达式必须包含在某个 `await` 表达式中，因为每个调用都包含一个潜在的 suspension point。一个 `await` 表达式可以包含一个以上的潜在 suspension point。例如，我们可以使用一个 `await` 来覆盖上面例子中的两个潜在的 suspension point，将其改写为：

```swift
let (data, response) = try await session.dataTask(with: server.redirectURL(for: url))
```

<!--
The `await` has no additional semantics; like `try`, it merely marks that an asynchronous call is being made.  The type of the `await` expression is the type of its operand, and its result is the result of its operand. An `await` operand may also have no potential suspension points, which will result in a warning from the Swift compiler, following the precedent of `try` expressions:
-->

`await` 没有额外的语义；与 `try` 一样，它只是标志着一个异步调用正在进行。`await` 表达式的类型是其操作对象的类型，其结果是其操作对象的结果。一个 `await` 操作数也可能没有潜在的 suspension point，这将导致 Swift 编译器发出警告，这是跟随 `try` 表达式的先例：

```swift
let x = await synchronous() // warning: no calls to 'async' functions occur within 'await' expression
```

<!--
> **Rationale**: It is important that asynchronous calls are clearly identifiable within the function because they may introduce suspension points, which break the atomicity of the operation.  The suspension points may be inherent to the call (because the asynchronous call must execute on a different executor) or simply be part of the implementation of the callee, but in either case it is semantically important and the programmer needs to acknowledge it. `await` expressions are also an indicator of asynchronous code, which interacts with inference in closures; see the section on [Closures](#closures) for more information.
-->

> **理由**：重要的是，异步调用在函数中应该具有明确的标识，因为它们可能会引入suspension point，从而打破操作的原子性。suspension point可能是调用所固有的（因为异步调用必须在不同的 executor 上执行），或者仅仅是被调用者实现的一部分，但无论哪种情况，它在语义上都是很重要的，工程师都需要意识到它。`await` 表达式也是异步代码的一个标识，它与闭包中的推导交互；更多信息请参见 [Closure](#closures) 一节。

<!--A potential suspension point must not occur within an autoclosure that is not of `async` function type.
-->

潜在的 suspension point 不可以发生在非 `async` 函数的 `@autoclosure` 里。

<!--
A potential suspension point must not occur within a `defer` block.
-->

潜在的 suspension point 不可以发生在 `defer` 里。

<!--
If both `await` and a variant of `try` (including `try!` and `try?`) are applied to the same subexpression, `await` must follow the `try`/`try!`/`try?`:
-->

如果 `await` 和 `try` 的变体（包括 `try!` 和 `try?`）被应用于同一个子表达式，`await` 必须跟在 `try`/`try!`/`try?` 后面。

```swift
let (data, response) = await try session.dataTask(with: server.redirectURL(for: url)) // error: must be `try await`
let (data, response) = await (try session.dataTask(with: server.redirectURL(for: url))) // okay due to parentheses
```

<!--
> **Rationale**: this restriction is arbitrary, but follows the equally-arbitrary restriction on the ordering of `async throws` in preventing stylistic debates.
-->

> **理由**：这一限制也是任意的，但延续了对 `async throws` 顺序的限制，以防止代码风格上的争论。

### Closures

<!--
A closure can have `async` function type. Such closures can be explicitly marked as `async` as follows:
-->

一个闭包也可以是 `async` 类型的。这类闭包可以明确标记为 `async` ，就像这样：

```swift
{ () async -> Int in
  print("here")
  return await getInt()
}
```

<!--
An anonymous closure is inferred to have `async` function type if it contains an `await` expression.
-->

一个匿名闭包如果包含一个 `await` 表达式，就会被推导为 `async` 类型：

```swift
let closure = { await getInt() } // implicitly async

let closure2 = { () -> Int in     // implicitly async
  print("here")
  return await getInt()
}
```

<!--
Note that inference of `async` on a closure does not propagate to its enclosing or nested functions or closures, because those contexts are separably asynchronous or synchronous. For example, only `closure6` is inferred to be `async` in this situation:
-->

请注意，闭包的 `async` 推导不会影响到它外层或嵌套的函数或闭包，因为这些上下文是独立的，异步或同步的。例如，在这种情况下，只有 `closure6` 被推导为 `async`：

```swift
// func getInt() async -> Int { ... }

let closure5 = { () -> Int in       // not 'async'
  let closure6 = { () -> Int in     // implicitly async
    if randomBool() {
      print("there")
      return await getInt()
    } else {
      let closure7 = { () -> Int in 7 }  // not 'async'
      return 0
    }
  }
  
  print("here")
  return 5
}
```

### 重载和重载规则

<!--
Existing Swift APIs generally support asynchronous functions via a callback interface, e.g.,
-->

现有的 Swift API 一般通过回调接口支持异步函数，例如：

```swift
func doSomething(completionHandler: ((String) -> Void)? = nil) { ... }
```

<!--
Many such APIs are likely to be updated by adding an `async` form:
-->

许多这样的 API 很可能会增加一个 `async` 形式的函数：

```swift
func doSomething() async -> String { ... }
```

<!--
These two functions have different names and signatures, even though they share the same base name. However, either of them can be called with no parameters (due to the defaulted completion handler), which would present a problem for existing code:
-->

这两个函数的名称和签名是不同的，尽管它们的名字一样。然而，它们中的任何一个函数都可能会在没有参数的情况下被调用（由于默认的代码补齐），这将给现有的代码带来一个问题：

```swift
doSomething() // problem: can call either, unmodified Swift rules prefer the `async` version
```

<!--
Swift's overloading rules prefer to call a function with fewer default arguments, so the addition of the `async` function would break existing code that called the original `doSomething(completionHandler:)` with no completion handler. This would get an error along the lines of:
-->

Swift 的重载规则更倾向于调用缺省参数较少的函数，所以增加 `async` 函数会破坏现有的代码，这些代码调用了原来的 `doSomething(completionHandler:)`，只是没传入 `completionHandler`。这将得到一个类似这样的编译错误：

```
error: `async` function cannot be called from non-asynchronous context
```

<!--
This presents problems for code evolution, because developers of existing asynchronous libraries would have to either have a hard compatiblity break (e.g, to a new major version) or would need have different names for all of the new `async` versions. The latter would likely result in a scheme such as [C#'s pervasive `Async` suffix](https://docs.microsoft.com/en-us/dotnet/csharp/programming-guide/concepts/async/task-asynchronous-programming-model).
-->

这会给代码演进带来了问题，因为现有异步库的作者要么硬性打破兼容性（例如，一个新的大版本），要么需要为所有新的 `async` 版本取不同的名字。后者很可能会演变类似于 [C# 普遍的 `Async` 后缀](https://docs.microsoft.com/en-us/dotnet/csharp/programming-guide/concepts/async/task-asynchronous-programming-model)。

<!--
Instead, we propose an overload-resolution rule to select the appropriate function based on the context of the call. Given a call, overload resolution prefers non-`async` functions within a synchronous context (because such contexts cannot contain a call to an `async` function).  Furthermore, overload resolution prefers `async` functions within an asynchronous context (because such contexts should avoid stepping out of the asynchronous model into blocking APIs). When overload resolution selects an `async` function, that call is still subject to the rule that it must occur within an `await` expression.
-->

相反，我们提出了一个重载解决规则，根据调用的上下文选择适当的函数。给定一个调用，在同步的上下文中，重载解析会优先选择非 `async` 函数（因为这种上下文不能包含对 `async` 函数的调用）。此外，在异步上下文中，重载解析会优先选择 `async` 函数（因为这种上下文应该避免从异步模型中跳出而进入阻塞的 API）。当重载解析选择 `async` 函数时，该调用仍然需要加上 `await`。

<!--
Note that we follow the design of `throws` in disallowing overloads that differ *only* in `async`:
-->

需要注意的是，我们延续了 `throws` 的设计，不允许只有 `async` 不同的重载：

```swift
func doSomething() -> String { /* ... */ }       // synchronous, blocking
func doSomething() async -> String { /* ... */ } // asynchronous

// error: redeclaration of function `doSomething()`.
```

### autoclosure

<!--
A function may not take an autoclosure parameter of `async` function type unless the function itself is `async`. For example, the following declaration is ill-formed:
-->

除非函数本身是 `async` 函数类型，否则函数不能接受 `async` 函数类型的 `@autoclosure` 参数。例如，下面的声明就是不规范的：

```swift
// error: async autoclosure in a function that is not itself 'async'
func computeArgumentLater<T>(_ fn: @escaping @autoclosure () async -> T) { } 
```

<!--
This restriction exists for several reasons. Consider the following example:
-->

这种限制的存在有几个原因。请看下面的例子：

```swift
// func getIntSlowly() async -> Int { ... }

let closure = {
  computeArgumentLater(await getIntSlowly())
  print("hello")
}
```

<!--
At first glance, the `await` expression implies to the programmer that there is a potential suspension point *prior* to the call to `computeArgumentLater(_:)`, which is not actually the case: the potential suspension point is *within* the (auto)closure that is passed and used within the body of `computeArgumentLater(_:)`. This causes a few problems. First, the fact that `await` appears to be prior to the call means that `closure` would be inferred to have `async` function type, which is also incorrect: all of the code in `closure` is synchronous. Second, because an `await`'s operand only needs to contain a potential suspension point somewhere within it, an equivalent rewriting of the call should be:
-->

乍一看，这里的 `await` 表达式在向工程师暗示，调用 `computeArgumentLater(_:)` 之前有一个潜在的 suspension point，但实际情况并非如此：潜在的 suspension point 是在 `computeArgumentLater(_:)` 主体传递和使用的闭包中。这导致了一些问题，首先 `await` 出现在调用之前意味着 `closure` 会被推导为具有 `async` 函数类型，这也是不正确的：`closure` 中的所有代码都是同步的。其次，由于 `await` 的操作对象只需要在其中某个地方包含一个潜在的 suspension point，因此调用的等效代码应该是：

```swift
await computeArgumentLater(getIntSlowly())
```

<!--
But, because the argument is an autoclosure, this rewriting is no longer semantics-preserving. Thus, the restriction on `async` autoclosure parameters avoids these problems by ensuring that `async` autoclosure parameters can only be used in asynchronous contexts.
-->

但是，由于参数是 autoclosure 的，这种重写不再保留之前的语义。因此，对 `async` autoclosure 参数的限制可以避免这些问题，只要确保 `async` autoclosure 参数只能在异步上下文中使用。

### Protocol conformance

<!--
A protocol requirement can be declared as `async`. Such a requirement can be satisfied by an `async` or synchronous function. However, a synchronous function requirement cannot be satisfied by an `async` function. For example:
-->

协议要求可声明为 `async`。这种要求可由 `async` 或同步函数来满足。但是，同步函数的要求不能由`async` 函数来满足。例如：

```swift
protocol Asynchronous {
  func f() async
}

protocol Synchronous {
  func g()
}

struct S1: Asynchronous {
  func f() async { } // okay, exactly matches
}

struct S2: Asynchronous {
  func f() { } // okay, synchronous function satisfying async requirement
}

struct S3: Synchronous {
  func g() { } // okay, exactly matches
}

struct S4: Synchronous {
  func g() async { } // error: cannot satisfy synchronous requirement with an async function
}
```

<!--
This behavior follows the subtyping/implicit conversion rule for asynchronous functions, as is precedented by the behavior of `throws`.
-->

这种行为遵循了异步函数的子类型/隐式转换规则，正如 `throws` 以前的行为。

## 代码兼容性

<!--
This proposal is generally additive: existing code does not use any of the new features (e.g., does not create `async` functions or closures) and will not be impacted. However, it introduces two new contextual keywords, `async` and `await`.
-->

这个提案总体上是补充性的：现有代码不会使用任何新的功能（例如，不会创建 `async` 函数或闭包），不会受到影响。但是，它引入了两个新的上下文关键字 `async` 和 `await`。

<!--
The positions of the new uses of `async` within the grammar (function declarations and function types) allows us to treat `async` as a contextual keyword without breaking source compatibility. A user-defined `async` cannot occur in those grammatical positions in well-formed code.
-->

`async` 在语法中的位置（函数声明和函数类型）使我们能够在不破坏源码兼容性的情况下将 `async` 作为上下文关键字来处理。在格式良好的代码中，用户定义的 `async` 不能出现在这些语法位置上。

<!--
The `await` contextual keyword is more problematic, because it occurs within an expression. For example, one could define a function `await` in Swift today:
-->

`await` 上下文关键字比较麻烦，因为它发生在一个表达式中。例如，今天可以在 Swift 中定义一个函数 `await`：

```swift
func await(_ x: Int, _ y: Int) -> Int { x + y }

let result = await(1, 2)
```

<!--
This is well-formed code today that is a call to the `await` function. With this proposal, this code becomes an `await` expression with the subexpression `(1, 2)`. This will manifest as a compile-time error for existing Swift programs, because `await` can only be used within an asynchronous context, and no existing Swift programs have such a context. Such functions do not appear to be common, so we believe this is an acceptable source break as part of the introduction of async/await.
-->

目前这段代码格式没有任何问题，它是对 `await` 函数的调用。但在这个提案里，这段代码变成了一个带有子表达式 `(1, 2)` 的 `await` 表达式。这对于现有的 Swift 程序来说，将表现为编译时错误，因为 `await` 只能在异步上下文中使用，而现有的 Swift 程序都没有这样的上下文。这样的函数似乎并不常见，所以我们认为这是一个可以接受的 source break，作为引入 async/await 的一部分。

## 对于 ABI 的影响

<!--
Asynchronous functions and function types are additive to the ABI, so there is no effect on ABI stability, because existing (synchronous) functions and function types are unchanged.
-->

异步函数和函数类型对 ABI 是补充性的，所以对 ABI 的稳定性没有影响，因为现有的（同步）函数和函数类型是不变的。

## 对于 API 的影响

<!--
The ABI for an `async` function is completely different from the ABI for a synchronous function (e.g., they have incompatible calling conventions), so the addition or removal of `async` from a function or type is not a resilient change.
-->

`async` 函数的 ABI 与同步函数的 ABI 完全不同（例如，它们有不兼容的调用惯例），所以从函数或类型中添加或删除 `async` 并不是一个兼容的修改。

## 未来方向

### `reasync`

<!--
Swift's `rethrows` is a mechanism for indicating that a particular function is throwing only when one of the arguments passed to it is a function that itself throws. For example, `Sequence.map` makes use of `rethrows` because the only way the operation can throw is if the transform itself throws:
-->

Swift 的 `rethrows` 是一种机制，用于表明只有当传递给它的参数之一是一个本身就会 `throws` 的函数时，某个函数才会抛出。例如，`Sequence.map` 就使用了 `rethrows`，因为只有当 `transform` 本身是 `throws` 时，`map` 操作才会 `throws`：

```swift
extension Sequence {
  func map<Transformed>(transform: (Element) throws -> Transformed) rethrows -> [Transformed] {
    var result = [Transformed]()
    var iterator = self.makeIterator()
    while let element = iterator.next() {
      result.append(try transform(element))   // note: this is the only `try`!
    }
    return result
  }
}
```

<!--
Here are uses of `map` in practice:
-->

这是实际代码中 `map` 的使用：

```swift
_ = [1, 2, 3].map { String($0) }  // okay: map does not throw because the closure does not throw
_ = try ["1", "2", "3"].map { (string: String) -> Int in
  guard let result = Int(string) else { throw IntParseError(string) }
  return result
} // okay: map can throw because the closure can throw
```

<!--
The same notion could be applied to `async` functions. For example, we could imagine making `map` asynchronous when its argument is asynchronous with `reasync`:
-->

同样的概念可以应用于 `async` 函数。例如，我们可以想象当 `map` 传入的闭包是异步的函数时，`map` 也将成为异步函数：

```swift
extension Sequence {
  func map<Transformed>(transform: (Element) async throws -> Transformed) reasync rethrows -> [Transformed] {
    var result = [Transformed]()
    var iterator = self.makeIterator()
    while let element = iterator.next() {
      result.append(try await transform(element))   // note: this is the only `try` and only `await`!
    }
    return result
  }
}
```

<!--
*Conceptually*, this is fine: when provided with an `async` function, `map` will be treated as `async` (and you'll need to `await` the result), whereas providing it with a non-`async` function, `map` will be treated as synchronous (and won't require `await`).
-->

*理论上*，这是没问题的：当提供一个 `async` 函数时，`map` 将被视为 `async`（你需要 `await` 结果），而提供一个非 `async` 函数时，`map` 将被视为同步的（不需要 `await`)。

<!--
*In practice*, there are a few problems here:
-->

*在实践中*，这里会有几个问题：

<!--
* This is probably not a very good implementation of an asynchronous `map` on a sequence. More likely, we would want a concurrent implementation that (say) processes up to number-of-cores elements concurrently.
* The ABI of throwing functions is intentionally designed to make it possible for a `rethrows` function to act as a non-throwing function, so a single ABI entry point suffices for both throwing and non-throwing calls. The same is not true of `async` functions, which have a radically different ABI that is necessarily less efficient than the ABI for synchronous functions.
-->

* 对于 Sequence 来说这可能不是一个很好的 `map` 实现。更有可能的是，我们想要一个并发的实现，（比如）并发处理多个元素。
* `throws` 函数的 ABI 被有意设计为使 `rethrows` 函数可以作为一个非抛出函数，因此一个 ABI 入口点就足以满足 throws 和 non-throws 的调用。而 `async` 函数则不同，它的 ABI 完全不同，其效率必然低于同步函数的 ABI。

<!--
For something like `Sequence.map` that might become concurrent, `reasync` is likely the wrong tool: overloading for `async` closures to provide a separate (concurrent) implementation is likely the better answer. So, `reasync` is likely to be much less generally applicable than `rethrows`.
-->

对于像 `Sequence.map` 这种可能并发的东西，`reasync` 可能是错误的工具：为 `async` 闭包重载以提供一个单独的（并发）实现可能是更好的答案。因此，`reasync` 可能没有 `rethrows` 那么普适。

<!--
There are undoubtedly some uses for `reasync`, such as the `??` operator for optionals, where the `async` implementation degrades nicely to a synchronous implementation:
-->

毋庸置疑，`reasync` 有它的用途，比如 `Optional` 的 `??` 操作符，`async` 的实现可以很好地降级为同步实现：

```swift
func ??<T>(
    _ optValue: T?, _ defaultValue: @autoclosure () async throws -> T
) reasync rethrows -> T {
  if let value = optValue {
    return value
  }

  return try await defaultValue()
}
```

<!--
For such cases, the ABI concern described above can likely be addressed by emitting two entrypoints: one when the argument is `async` and one when it is not. However, the implementation is complex enough that the authors are not yet ready to commit to this design.
-->

对于这种情况，可以通过发出两个入口点来解决上文所述的 ABI 问题：一个是当参数是 `async` 时，另一个是当参数不是时。然而，由于实现方式非常复杂，作者还没有准备好采用这种设计。

## 替代方案

### 让 `await` 隐含 `try`

<!--
Many asynchronous APIs involve file I/O, networking, or other failable operations, and therefore will be both `async` and `throws`. At the call site, this means `try await` will be repeated many times. To reduce the boilerplate, `await` could imply `try`, so the following two lines would be equivalent:
-->

许多异步 API 都涉及文件 I/O、网络请求或其它可能失败的操作，因此会同时出现 `async` 和 `throws`。在调用方，这意味着 `try await` 将被重复多次。为了减少模板，可以让 `await` 隐含 `try`，所以下面两行将是等价的：

```swift
let dataResource  = await loadWebResource("dataprofile.txt")
let dataResource  = try await loadWebResource("dataprofile.txt")
```

<!--
We chose not to make `await` imply `try` because they are expressing different kinds of concerns: `await` is about a potential suspension point, where other code might execute in between when you make the call and it when it returns, while `try` is about control flow out of the block.
-->

我们选择不让 `await` 隐含 `try`，因为它们表达的是不同的含义。`await` 是关于一个潜在的 suspension point，即在你进行调用和它返回之间可能会有其他代码执行，而 `try` 则是关于 block 外的控制流。

<!--
One other motivation that has come up for making `await` imply `try` is related to task cancellation. If task cancellation were modeled as a thrown error, and every potential suspension point implicitly checked whether the task was cancelled, then every potential suspension point could throw: in such cases `await` might as well imply `try` because every `await` can potentially exit with an error. Task cancellation is covered in the [Structured Concurrency](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md) proposal, and does *not* model cancellation solely as a thrown error nor does it introduce implicit cancellation checks at each potential suspension point.
-->

使 `await` 隐含 `try` 的另一个原因与任务取消有关。如果任务取消被建模为一个抛出的错误，并且每个潜在的 suspension point 都隐式地检查任务是否被取消，那么每个潜在的 suspension point 都可能抛出：在这种情况下，`await` 也可能意味着 `try`，因为每个 `await` 都可能带着错误退出。任务取消在[结构化并发](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md)提案中有所涉及，并*没有*仅将取消建模为抛出的错误，也没有在每个潜在的 suspension point 引入隐式的取消检查。

### 启动 async 任务

<!--
Because only `async` code can call other `async` code, this proposal provides no way to initiate asynchronous code. This is intentional: all asynchronous code runs within the context of a "task", a notion which is defined in the [Structured Concurrency](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md) proposal. That proposal provides the ability to define asynchronous entry points to the program via `@main`, e.g.,
-->

因为只有 `async` 代码才能调用其他 `async` 代码，所以本提案没有提供启动异步代码的方法。这是有意的：所有异步代码都在 "task" 的上下文中运行，这个概念在[结构化并发](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md)提案中得到了定义。该提案提供了通过 `@main` 来定义程序的异步入口的能力，例如：

```swift
@main
struct MyProgram {
  static func main() async { ... }
}
```

<!--
Additionally, top-level code is not considered an asynchronous context in this proposal, so the following program is ill-formed:
-->

此外，在本提案中，顶层代码不被视为异步上下文，所以下面的程序是不合法的：

```swift
func f() async -> String { "hello, asynchronously" }

print(await f()) // error: cannot call asynchronous function in top-level code
```

<!--
This, too, will be addressed in a subsequent proposal that properly accounts for top-level variables.
-->

这一点也将在随后的提案中得到解决，该提案将适当考虑到顶层变量。

<!--
None of the concerns for top-level code affect the fundamental mechanisms of async/await as defined in this proposal.
-->

对顶层代码的处理并不会影响本提案中定义的 async/await 基本机制。

### await 作为语法糖

<!--
This proposal makes `async` functions a core part of the Swift type system, distinct from synchronous functions. An alternative design would leave the type system unchanged, and instead make `async` and `await` syntactic sugar over some `Future<T, Error>` type, e.g.,
-->

这个建议使 `async` 函数成为 Swift 类型系统的核心部分，与同步函数不同。另一种设计是不改变类型系统，而是将 `async` 和 `await` 的语法糖化在一些 `Future<T, Error>` 类型上，例如：

```swift
async func processImageData() throws -> Future<Image, Error> {
  let dataResource  = try loadWebResource("dataprofile.txt").await()
  let imageResource = try loadWebResource("imagedata.dat").await()
  let imageTmp      = try decodeImage(dataResource, imageResource).await()
  let imageResult   = try dewarpAndCleanupImage(imageTmp).await()
  return imageResult
}
```

<!--
This approach has a number of downsides vs. the proposed approach here:
-->

这种方法与这里提出的方法相比，有许多缺点：

<!--
* There is no universal `Future` type on which to build it in the Swift ecosystem. If the Swift ecosystem had mostly settled on a single future type already (e.g., if there were already one in the standard library), a syntactic-sugar approach like the above would codify existing practice. Lacking such a type, one would have to try to abstract over all of the different kinds of future types with some kind of `Futurable` protocol. This may be possible for some set of future types, but would give up any guarantees about the behavior or performance of asynchronous code.
* It is inconsistent with the design of `throws`. The result type of asynchronous functions in this model is the future type (or "any `Futurable` type"), rather than the actual returned value. They must always be `await`'ed immediately (hence the postfix syntax) or you'll end up working with futures when you actually care about the result of the asynchronous operation. This becomes a programming-with-futures model rather than an asynchronous-programming model, when many other aspects of the `async` design intentionally push away from thinking about the futures.
* Taking `async` out of the type system would eliminate the ability to do overloading based on `async`. See the prior section on the reasons for overloading on `async`.
* Futures are relatively heavyweight types, and forming one for every async operation has nontrivial costs in both code size and performance. In contrast, deep integration with the type system allows `async` functions to be purpose-built and optimized for efficient suspension. All levels of the Swift compiler and runtime can optimize `async` functions in a manner that would not be possible with future-returning functions.
-->

* 在 Swift 生态系统中，没有通用的 `Future` 类型可供使用。如果 Swift 生态系统已经基本确定了一个单一的 `Future` 类型(例如，如果标准库中已经有了一个 `Future` 类型)，那么像上面这样的语法糖方法就会改变现有的实践。如果缺乏这样的类型，就必须尝试用某种 `Futurable` 协议来抽象所有不同种类的 `Future` 类型。对于某些 `Future` 类型来说，这也许是可能的，但会放弃对异步代码行为或性能的任何保证。
* 这与 `throws` 的设计不一致。在这个模型中，异步函数的结果类型是 `Future` 类型（或 "任何`Futurable` 类型"），而不是实际返回值。它们必须总是立即 `await`，否则当你关心异步操作真正的结果时，你最终还是会到用 `Future` 的接口。这就变成了一个使用 `Future` 的编程模型，而不是异步编程模型，并且 `async` 设计的许多方面都有意不去考虑 `Future`。
* 把 `async` 从类型系统中拿出来，就会限制基于 `async` 进行重载的能力。参见前文关于在 `async` 上进行重载的原因。
* `Future` 是比较重量级的类型，为每一个 `async` 操作生成一个类型实例在代码大小和性能上都有不小的代价。相比之下，与类型系统的深度集成，使得 `async` 函数可以有针对性地构建和优化，从而实现高效 suspension。Swift 编译器和运行时的每一层都可以对 `async` 函数进行优化，而这种优化方式在基于 `Future` 的模型里是几乎不可行的。

## 修订历史

* Post-review changes:
   * Replaced `await try` with `try await`.
   * Added syntactic-sugar alternative design.
* Changes in the second pitch:
	* One can no longer directly overload `async` and non-`async` functions. Overload resolution support remains, however, with additional justification.
	* Added an implicit conversion from a synchronous function to an asynchronous function.
	* Added `await try` ordering restriction to match the `async throws` restriction.
	* Added support for `async` initializers.
	* Added support for synchronous functions satisfying an `async` protocol requirement.
	* Added discussion of `reasync`.
	* Added justification for `await` not implying `try`.
	* Added justification for `async` following the function parameter list.

* Original pitch ([document](https://github.com/DougGregor/swift-evolution/blob/092c05eebb48f6c0603cd268b7eaf455865c64af/proposals/nnnn-async-await.md) and [forum thread](https://forums.swift.org/t/concurrency-asynchronous-functions/41619)).

## 相关提案

除本提案外，还有一些相关提案，涵盖了 Swift 并发模型的不同方面。

* [Concurrency Interoperability with Objective-C](https://github.com/DougGregor/swift-evolution/blob/concurrency-objc/proposals/NNNN-concurrency-objc.md): 描述与 Objective-C 的交互，特别是接收回调的异步 Objective-C 方法与 `@objc async` Swift 方法之间的关系。
* [Structured Concurrency](https://github.com/DougGregor/swift-evolution/blob/structured-concurrency/proposals/nnnn-structured-concurrency.md)：描述了异步调用所使用的任务结构、子任务和分离任务的创建、取消、优先级和其他任务管理 API。
* [Actors](https://github.com/DougGregor/swift-evolution/blob/actors/proposals/nnnn-actors.md): 描述了为并发程序提供状态隔离的 actor 模型。

## 鸣谢

<!--
The desire for async/await in Swift has been around for a long time. This proposal draws some inspiration (and most of the Motivation section) from an earlier proposal written by [Chris Lattner](https://github.com/lattner) and [Joe Groff](https://github.com/jckarter), available [here](https://gist.github.com/lattner/429b9070918248274f25b714dcfc7619). That proposal itself is derived from a proposal written by [Oleg Andreev](https://github.com/oleganza), available [here](https://gist.github.com/oleganza/7342ed829bddd86f740a). It has been significantly rewritten (again), and many details have changed, but the core ideas of asynchronous functions have remained the same.
-->

在 Swift 中实现 async/await 的想法由来已久。这个提案从 [Chris Lattner](https://github.com/lattner) 和 [Joe Groff](https://github.com/jckarter) 撰写的早期提案中获得了一些灵感(以及动机部分的大部分内容)，可以在[这里](https://gist.github.com/lattner/429b9070918248274f25b714dcfc7619)找到。该提案本身源自 [Oleg Andreev](https://github.com/oleganza) 撰写的提案，可在[这里](https://gist.github.com/oleganza/7342ed829bddd86f740a)查阅。它经过了重大的改写（再次），许多细节都发生了变化，但异步函数的核心思想没有改变。

<!--
Efficient implementation is critical for the introduction of asynchronous functions, and Swift Concurrency as a whole. Nate Chandler, Erik Eckstein, Kavon Farvardin, Joe Groff, Chris Lattner, Slava Pestov, and Arnold Schwaighofer all made significant contributions to the implementation of this proposal.
-->

高效的实现对于异步函数的引入，以及整个 Swift 并发来说都是至关重要的。Nate Chandler、Erik Eckstein、Kavon Farvardin、Joe Groff、Chris Lattner、Slava Pestov 和 Arnold Schwaighofer 都为这个提案的实现做出了重要贡献。
