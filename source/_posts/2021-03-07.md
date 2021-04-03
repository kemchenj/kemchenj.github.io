---
title: 【译】SE-0297 Concurrency 与 Objective-C 的交互
date: 2021-03-07
---

> 原文链接：[SE-0297 Concurrency Interoperability with Objective-C](https://github.com/apple/swift-evolution/blob/main/proposals/0297-concurrency-objc.md)

* Proposal: [SE-0297](https://github.com/apple/swift-evolution/blob/main/proposals/0297-concurrency-objc.md)
* Author: [Doug Gregor](https://github.com/DougGregor)
* Review Manager: [Chris Lattner](https://github.com/lattner)
* Status: **Implemented (Swift 5.5)**
* [Acceptance Post](https://forums.swift.org/t/accepted-with-modifications-se-0297-concurrency-interoperability-with-objective-c/43306)
* Implementation: Partially available in [recent `main` snapshots](https://swift.org/download/#snapshots) behind the flag `-Xfrontend -enable-experimental-concurrency`

<!--
## Table of Contents

* [Introduction](#introduction)
* [Motivation](#motivation)
* [Proposed solution](#proposed-solution)
* [Detailed design](#detailed-design)
   * [Asynchronous completion-handler methods](#asynchronous-completion-handler-methods)
   * [Defining asynchronous @objc methods in Swift](#defining-asynchronous-objc-methods-in-swift)
   * [Actor classes](#actor-classes)
   * [Completion handlers must be called exactly once](#completion-handlers-must-be-called-exactly-once)
   * [Additional Objective-C attributes](#additional-objective-c-attributes)
* [Source compatibility](#source-compatibility)
* [Revision history](#revision-history)
* [Future Directions](#future-directions)
   * [NSProgress](#nsprogress)
-->

## 简介

<!--
Swift's concurrency feature involves asynchronous functions and actors. While Objective-C does not have corresponding language features, asynchronous APIs are common in Objective-C, expressed manually through the use of completion handlers. This proposal provides bridging between Swift's concurrency features (e.g., `async` functions) and the convention-based expression of asynchronous functions in Objective-C. It is intended to allow the wealth of existing asynchronous Objective-C APIs to be immediately usable with Swift's concurrency model.
-->

Swift 的并发功能包括了异步函数和 actor。虽然 Objective-C 没有相应的语言特性，但异步 API 在 Objective-C 中很常见，通过使用 completion-handler 手动实现。本提案提供了 Swift 的并发特性（如 `async` 函数）和 Objective-C 中基于约定的异步函数表达之间的桥接。它的目的是让现有的丰富的异步 Objective-C API 可以立即与 Swift 的并发模型一起使用。

<!--more-->

<!--
For example, consider the following Objective-C API in [CloudKit](https://developer.apple.com/documentation/cloudkit/ckcontainer/1640387-fetchshareparticipantwithuserrec):
-->

例如，试想一下 [CloudKit](https://developer.apple.com/documentation/cloudkit/ckcontainer/1640387-fetchshareparticipantwithuserrec) 中的 Objective-C API：

```objectivec
- (void)fetchShareParticipantWithUserRecordID:(CKRecordID *)userRecordID 
    completionHandler:(void (^)(CKShareParticipant * _Nullable, NSError * _Nullable))completionHandler;
```

<!--
This API is asynchronous. It delivers its result (or an error) via completion handler. The API directly translates into Swift:
-->

这个 API 是异步的，它通过 completion-handler 来提供它的结果（或错误），这个 API 直接翻译到 Swift：

```swift
func fetchShareParticipant(
    withUserRecordID userRecordID: CKRecord.ID, 
    completionHandler: @escaping (CKShare.Participant?, Error?) -> Void
)
```

<!--
Existing Swift code can call this API by passing a closure for the completion handler. This proposal provides an alternate Swift translation of the API into an `async` function, e.g.,
-->

现有的 Swift 代码可以通过向 completion-handler 传入一个闭包来调用这个 API。这个提案提供了一个新的 API 翻译方案，可以将这一类 API 翻译为 `async` 函数，例如：

```swift
func fetchShareParticipant(
    withUserRecordID userRecordID: CKRecord.ID
) async throws -> CKShare.Participant
```

<!--
Swift callers can invoke `fetchShareParticipant(withUserRecordID:)` within an `await` expression:
-->

Swift 调用者可以使用 `await` 表达式来调用 `fetchShareParticipant(withUserRecordID:)`：

```swift
guard let participant = try? await container.fetchShareParticipant(withUserRecordID: user) else {
    return nil
}
```

Swift-evolution thread: [\[Concurrency\] Interoperability with Objective-C](https://forums.swift.org/t/concurrency-interoperability-with-objective-c/41616)

## 动机

<!--
On Apple platforms, Swift's tight integration with Objective-C APIs is an important part of the developer experience. There are several core features:
-->

在 Apple 的平台上，Swift 与 Objective-C API 的紧密集成是开发者体验的重要组成部分之一。有这几个核心功能：

<!--
* Objective-C classes, protocols, and methods can be used directly from Swift.
* Swift classes can subclass Objective-C classes.
* Swift classes can declare conformance to Objective-C protocols.
* Swift classes, protocols, and methods can be made available to Objective-C via the `@objc` attribute.
-->

* Objective-C 类、协议和方法可以直接在 Swift 中使用。
* Swift 类可以继承 Objective-C 类。
* Swift 类可以声明与 Objective-C 协议的 conformance。
* Swift 类、协议和方法可以通过 `@objc` 注解提供给 Objective-C。

<!--
Asynchronous APIs abound in Objective-C code: the iOS 14.0 SDK includes nearly 1,000 methods that accept completion handlers. These include methods that one could call directly from Swift, methods that one would override in a Swift-defined subclass, and methods in protocols that one would conform to. Supporting these use cases in Swift's concurrency model greatly expands the reach of this new feature. 
-->

异步 API 在 Objective-C 代码中比比皆是：iOS 14.0 SDK 中包含了近 1000 个接收 completion-handler 的方法，其中包括可以从 Swift 中直接调用的方法，可以在 Swift 定义的子类中 override 的方法，以及 conform 协议的方法。在 Swift 的并发模型中支持这些用例，可以大大扩展这个新功能的应用范围。

## 解决方案

<!--
The proposed solution provides interoperability between Swift's concurrency constructs and Objective-C in various places. It has several inter-dependent pieces:
-->

本提案提出的解决方案，尝试在几个不同的维度提供 Swift 并发结构和 Objective-C 之间的交互。它包含了这几个相互依赖的组成部分：

<!--
* Translate Objective-C completion-handler methods into `async` methods in Swift.
* Allow `async` methods defined in Swift to be `@objc`, in which case they are exported as completion-handler methods.
* Provide Objective-C attributes to control over how completion-handler-based APIs are translated into `async` Swift functions.
-->

* 在 Swift 中把 Objective-C 接收 completion-handler 的函数翻译成 `async` 方法。
* 允许在 Swift 中定义的 `async` 方法被注解为 `@objc`，在这种情况下，它们将导出为基于 completion-handler 的方法。（供 Objective-C 调用）
* 提供 Objective-C 注解，基于 completion-handler 的 API 转化为 `async` Swift函数的流程可以用它来控制。

<!--
The detailed design section describes the specific rules and heuristics being applied. However, the best way to evaluate the overall effectiveness of the translation is to see its effect over a large number of Objective-C APIs. [This pull request](https://github.com/DougGregor/swift-concurrency-objc/pull/1) demonstrates the effect that this proposal has on the Swift translations of Objective-C APIs across the Apple iOS, macOS, tvOS, and watchOS SDKs.
-->

下面的设计细节描述了具体的规则和推导方法。然而，评估整体翻译效果的最佳方式还是查看它应用在 Objective-C API 上的实际效果。[这个 Pull Reqeust](https://github.com/DougGregor/swift-concurrency-objc/pull/1) 展示了这个提案对苹果 iOS、macOS、tvOS 和 watchOS SDK 中Objective-C API 的 Swift 翻译的效果。

## 设计细节

### 异步 completion-handler 方法

<!--
An Objective-C method is potentially an asynchronous completion-handler method if it meets the following requirements:
-->

如果一个 Objective-C 方法满足以下要求，那它就可以看作是一个异步 completion-handler 方法：

<!--
* The method has a completion handler parameter, which is an Objective-C block that will receive the "result" of the asynchronous computation. It must meet the following additional constraints:
  * It has a `void` result type.
  * It is called exactly once along all execution paths through the implementation.
  * If the method can deliver an error, one of the parameters of the block is of type `NSError *` that is not `_Nonnull`. A non-nil `NSError *` value typically indicates that an error occurred, although the C `swift_async` attribute can describe other conventions (discussed in the section on Objective-C attributes).
* The method itself has a `void` result type, because all results are delivered by the completion handler block.
-->

* 该方法有一个 completion-handler 参数，它是一个 Objective-C 闭包，接收异步运算的"结果"。它必须满足以下额外的限制条件： 
  * 它的返回值类型是 `void`。
  * 它在整个实现的所有执行路径中只被调用一次。
  * 如果它可以传入 error，并且闭包包含了一个是类型为 `NSError *` 的参数，并且不是 `_Nonnull`。一个非 null 的 `NSError *` 值通常表示发生了 error，尽管 C 语言的 `swift_async` 属性可以使用其他约定（在 Objective-C 注解一节中讨论）。
* 方法本身的返回值类型是 `void`，因为所有的结果都是由 completion-handler 闭包传递的。

<!--
An Objective-C method that is potentially an asynchronous completion-handler method will be translated into an `async` method when it is either annotated explicitly with an appropriate `swift_async` attribute (described in the section on Objective-C attributes) or is implicitly inferred when the following heuristics successfully identify the completion handler parameter:
-->

一个可能是异步 completion-handler 方法的 Objective-C 方法将被翻译成一个 `async` 方法，当它被显式地注解为一个适当的 `swift_async` 属性（在 Objective-C 注解一节中有详细说明），或者当下面的推导成功地识别出 completion-handler 参数时，它就被隐式地推导为 async 方法：

<!--
* If the method has a single parameter, and the suffix of the first selector piece is one of the following phrases:
  - `WithCompletion`
  - `WithCompletionHandler`
  - `WithCompletionBlock`
  - `WithReplyTo`
  - `WithReply`
  the sole parameter is the completion handler parameter. The matching phrase will be removed from the base name of the function when it is imported.
* If the method has more than one parameter, the last parameter is the completion handler parameter if its selector piece or parameter name is `completion`, `withCompletion`, `completionHandler`, `withCompletionHandler`, `completionBlock`, `withCompletionBlock`, `replyTo`, `withReplyTo`,  `reply`, or `replyTo`.
* If the method has more than one parameter, and the last parameter ends with one of the suffixes from the first bullet, the last parameter is the completion handler. The text preceding the suffix is appended to the base name of the function.
-->

* 如果该方法只有一个参数，而且第一个 selector 的后缀是下列短语之一：
  - `WithCompletion`
  - `WithCompletionHandler`
  - `WithCompletionBlock`
  - `WithReplyTo`
  - `WithReply`
  唯一参数是 completion-handler 参数。当导入函数时，匹配的短语将从函数的名字中移除。
* 如果方法有一个以上的参数，如果它的 selector 外参或内参名字是 `completion`、`withCompletion`、 `completionHandler`、 `withCompletionHandler`、 `completionBlock`、 `withCompletionBlock`、 `replyTo`、 `withReplyTo`、 `reply` 或 `replyTo`，则最后一个参数看作是 completion-handler 参数。
* 如果方法有一个以上的参数，并且最后一个参数以第一个规则中的其中一个后缀结尾，则最后一个参数将被推导为 completion-handler。后缀前面的文字被附加到函数的名称里。

<!--
When the completion handler parameter is inferred, the presence of an `NSError *` parameter that is not `_Nonnull` in the completion handler block type indicates that the translated method can deliver an error.
-->

当推导出 completion-handler 参数时，如果 completion-handler 闭包类型中存在一个不是 `_Nonnull` 的 `NSError *` 参数，则表明翻译后的方法可以传递 error。

<!--
The translation of an asynchronous Objective-C completion-handler method into an `async` Swift method follows the normal translation procedure, with the following alterations:
-->

将一个异步的 Objective-C completion-handler 方法翻译成一个 `async`  Swift 方法将遵循正常的翻译规则，但做了以下改动：

<!--
* The completion handler parameter is removed from the parameter list of the translated Swift method.
* If the method can deliver an error, it is `throws` in addition to being `async`.
* The parameter types of the completion handler block type are translated into the result type of the `async` method, subject to the following additional rules:
  * If the method can deliver an error, the `NSError *` parameter is ignored. 
  * If the method can deliver an error and a given parameter has the `_Nullable_result` nullability qualifier (see the section on Objective-C attributes below), it will be imported as optional. Otherwise, it will be imported as non-optional.
  * If there are multiple parameter types, they will be combined into a tuple type.
-->

* completion-handler 参数从翻译后的 Swift 方法的参数列表中删除。
* 如果该方法可以传入一个 error，那么它除了是 `async` 之外，还会是 `throws` 的。
* completion-handler 闭包的参数类型会被翻译成 `async` 方法的结果类型，但要遵守以下附加规则：
  * 如果该方法可以传入一个 error，则忽略 `NSError *` 参数。
  * 如果该方法可以传入一个 error，并且给定的参数具有 `_Nullable_result` nullability 的标注（参见下面的 Objective-C 注解一节），那么它将作为 optional 参数被导入。否则，它将被作为 non-optional 参数导入。
  * 如果有多个参数类型，它们将被合并成一个元组类型。

<!--The following [PassKit API](https://developer.apple.com/documentation/passkit/pkpasslibrary/3543357-signdata?language=objc) demonstrates how the inference rule plays out:
-->

下面 [PassKit 的 API](https://developer.apple.com/documentation/passkit/pkpasslibrary/3543357-signdata?language=objc) 展示了推导规则是怎么发挥作用的：

```objectivec
- (void)signData:(NSData *)signData 
withSecureElementPass:(PKSecureElementPass *)secureElementPass 
      completion:(void (^)(NSData *signedData, NSData *signature, NSError *error))completion;
```

<!--
Today, this is translated into the following completion-handler function in Swift:
-->

目前这个函数在 Swift 中被翻译成这样的 completion-handler 函数：

```swift
@objc func sign(_ signData: Data, 
    using secureElementPass: PKSecureElementPass, 
    completion: @escaping (Data?, Data?, Error?) -> Void
)
```

<!--
This will be translated into the following `async` function:
-->

它将会被翻译成这样的 `async` 函数：

```swift
@objc func sign(
    _ signData: Data, 
    using secureElementPass: PKSecureElementPass
) async throws -> (Data, Data)
```

<!--
When the compiler sees a call to such a method, it effectively uses `withUnsafeContinuation` to form a continuation for the rest of the function, then wraps the given continuation in a closure. For example:
-->

当编译器看到对这种方法的调用时，它会使用 `withUnsafeContinuation` 为函数的其余部分生成一个 `continuation`，然后将给定的 `continuation` 封装进一个闭包里。例如：

```swift
let (signedValue, signature) = try await passLibrary.sign(signData, using: pass)
```

<!--
becomes pseudo-code similar to
-->

将成为类似于这样的代码：

```swift
try withUnsafeContinuation { continuation in 
    passLibrary.sign(
        signData, using: pass, 
        completionHandler: { (signedValue, signature, error) in
            if let error = error {
                continuation.resume(throwing: error)
            } else {
                continuation.resume(returning: (signedValue!, signature!))
            }
        }
    )
}
```

<!--
Additional rules are applied when translating an Objective-C method name into a Swift name of an `async` function:
-->

把 Objective-C 方法名翻译成 `async` 函数时，在 Swift 里的名称会有额外的规则：

<!--
* If the base name of the method starts with `get`, the `get` is removed and the leading initialisms are lowercased.
* If the base name of the method ends with `Asynchronously`, that word is removed.
-->

* 如果方法的名称以 `get` 开头，则去掉 `get`，`get` 后面的词改成小写。
* 如果方法的名称以 `Asynchronously` 结尾，则删除该词。

<!--
If the completion-handler parameter of the Objective-C method is nullable and the translated `async` method returns non-`Void`, it will be marked with the `@discardableResult` attribute. For example:
-->

如果 Objective-C 方法的 completion-handler 参数是 optional 的，且翻译后的 `async` 方法返回类型不是 `Void`，则会用 `@discardableResult` 注解来标记。比如说：

```objectivec
-(void)stopRecordingWithCompletionHandler:void(^ _Nullable)(RPPreviewViewController * _Nullable, NSError * _Nullable)handler;
```

会成为：

```swift
@discardableResult func stopRecording() async throws -> RPPreviewViewController
```

### 在 Swift 里定义异步 `@objc` 方法

<!--
Many Swift entities can be exposed to Objective-C via the `@objc` attribute. With an `async` Swift method, the compiler will add an appropriate completion-handler parameter to the Objective-C method it creates, using what is effectively the inverse of the transformation described in the previous section, such that the Objective-C method produced is an asynchronous Objective-C completion-handler method. For example, a method such as:
-->

许多 Swift 符号可以通过 `@objc` 注解暴露给 Objective-C。有了 `async` Swift 方法，编译器将在它创建的 Objective-C 方法中添加一个相应的 completion-handler 参数，使用的是上一节中介绍的转换规则的反向版本，这样产生的 Objective-C 方法就是一个异步的 Objective-C completion-handler 方法。例如，一个类似于这样的方法：

```swift
@objc func perform(operation: String) async -> Int { ... }
```

<!--
will translate into the following Objective-C method:
-->

将翻译为这样的 Objective-C 方法：

```objectivec
- (void)performWithOperation:(NSString * _Nonnull)operation
           completionHandler:(void (^ _Nullable)(NSInteger))completionHandler;
```

<!--
The Objective-C method implementation synthesized by the compiler will create a detached task that calls the `async` Swift method `perform(operation:)` with the given string, then (if the completion handler argument is not `nil`) forwards the result to the completion handler.
-->

编译器合成的 Objective-C 方法实现将创建一个独立任务，这个任务会用传入的字符串调用 `async` Swift 方法 `perform(operation:)`，然后将结果转发给 completion-handler（如果 completion-handler 不是 `nil` 的话）。

<!--
For an `async throws` method, the completion handler is extended with an `NSError *` parameter to indicate the error, any non-nullable pointer type parameters are made `_Nullable`, and any nullable pointer type parameters are made `_Nullable_result`. For example, given:
-->

对于一个 `async throws` 方法，completion-handler 扩展了一个 `NSError *` 参数来表示 error，任何 non-nullable 的指针类型的参数都做成 `_Nullable`，任何 nullable 指针类型的参数都做成 `_Nullable_result`。例如：

```swift
@objc func performDangerousTrick(operation: String) async throws -> String { ... }
```

<!--
the resulting Objective-C method will have the following signature:
-->

产生的 Objective-C 方法签名会是这样的：

```objectivec
- (void)performDangerousTrickWithOperation:(NSString * _Nonnull)operation
    completionHandler:(void (^ _Nullable)(NSString * _Nullable, NSError * _Nullable))completionHandler;
```

<!--
Again, the synthesized Objective-C method implementation will create a detached task that calls the `async throws` method `performDangerousTrick(operation:)`. If the method returns normally, the `String` result will be delivered to the completion handler in the first parameter and the second parameter (`NSError *`) will be passed `nil`. If the method throws, the first parameter will be passed `nil` (which is why it has been made `_Nullable` despite being non-optional in Swift) and the second parameter will receive the error. If there are non-pointer parameters, they will be passed zero-initialized memory in the non-error arguments to provide consistent behavior for callers. This can be demonstrated with Swift pseudo-code:
-->

同样，合成的 Objective-C 方法实现将创建一个独立任务，调用 `async throws` 方法`performDangerousTrick(operation:)`。如果方法正常返回，那么 `String` 结果将在第一个参数中传入给 completion-handler，第二个参数（`NSError *`）将传入 `nil`。如果方法是 `throws` 的，第一个参数将被传入 `nil`（这就是为什么它被做成 `_Nullable`，尽管在 Swift 中是 non-optional 的），第二个参数将收到 error。如果有非指针参数，它们将在非错误参数中传递初始化为零的内存，为调用者提供一致的行为。这里可以用等效的 Swift 代码来帮助理解：

```swift
// Synthesized by the compiler
@objc func performDangerousTrick(
    operation: String,
    completionHandler: ((String?, Error?) -> Void)?
) {
    runDetached {
        do {
            let value = try await performDangerousTrick(operation: operation)
            completionHandler?(value, nil)
        } catch {
            completionHandler?(nil, error)
        }
    }
}
```

### Actor 类

<!--
Actor classes can be `@objc` and will be available in Objective-C as are other classes. Actor classes require that their superclass (if there is one) also be an actor class. However, this proposal loosens that requirement slightly to allow an actor class to have `NSObject` as its superclass. This is conceptually safe because `NSObject` has no state (and its layout is effectively fixed that way), and makes it possible both for actor classes to be `@objc` and also implies conformance to `NSObjectProtocol`, which is required when conforming to a number of Objective-C protocols and is otherwise unimplementable in Swift. 
-->

Actor 类可以是 `@objc` 的，并将在 Objective-C 中和其他类一样可用。Actor 类要求其父类（如果有的话）也是 Actor 类。然而，这个提案稍微放宽了这个要求，允许一个 actor 类将 `NSObject` 作为它的父类。在理论上这是安全的，因为 `NSObject` 没有状态(而且它的布局实际上是固定的)，并且使得 actor 类既可以是 `@objc` 的，也意味着它遵循le1 `NSObjectProtocol`，这在实现一些 Objective-C 协议时是必要的，否则在 Swift 中是无法实现的。

<!--
A member of an actor class can only be `@objc` if it is either `async` or is outside of the actor's isolation domain. Synchronous code that is within the actor's isolation domain can only be invoked on `self` (in Swift). Objective-C does not have knowledge of actor isolation, so these members are not permitted to be exposed to Objective-C. For example:
-->

一个 actor 类的成员只有在它是 `async` 或在 actor 的隔离域之外时才能成为 `@objc`。在 actor 隔离域内的同步代码只能在 `self` 上被调用（在 Swift 中）。Objective-C 没有 actor 隔离的概念，所以这些成员是不允许暴露在 Objective-C 中的。比如说：

```swift
actor class MyActor {
    @objc func synchronous() { } // error: part of actor's isolation domain
    @objc func asynchronous() async { } // okay: asynchronous
    @objc @actorIndependent func independent() { } // okay: actor-independent
}
```

### completion-handler 必须只调用一次

<!--
A Swift `async` function will always suspend, return, or (if it throws) produce an error. For completion-handler APIs, it is important that the completion handler block be called exactly once on all paths, including when producing an error. Failure to do so will break the semantics of the caller, either by failing to continue or by executing the same code multiple times. While this is an existing problem, widespread use of `async` with incorrectly-implemented completion-handler APIs might exacerbate the issue.
-->

一个 Swift `async` 函数总是会暂停、返回或（如果它是 throws 的话）抛出一个错误。对于 completion-handler API 来说，重要的是 completion-handler 在所有路径上都被准确地调用一次，包括抛出错误时。如果不这样做，就会破坏调用者的语义，要么不能继续，要么多次执行相同的代码。虽然这是一个目前就存在的问题，但广泛使用 `async` 和没有正确实现的 completion-handler 可能会加剧这个问题。

<!--
Fortunately, because the compiler itself is synthesizing the block that will be passed to completion-handler APIs, it can detect both problems by introducing an extra bit of state into the synthesized block to indicate that the block has been called. If the bit is already set when the block is called, then it has been called multiple times. If the bit is not set when the block is destroyed, it has not been called at all. While this does not fix the underlying problem, it can at least detect the issue consistently at run time.
-->

幸运的是，由于编译器本身会负责生成将被传递给 completion-handler API 的闭包，它可以通过在合成的闭包中引入一个额外的标志位来检测这两个问题，表明这个闭包是否已经被调用过。如果当闭包被调用时，这个标志位有值了，那么就证明它已经被多次调用。如果这个标志位在闭包被销毁时没有被设置过，则说明它根本没有被调用过。虽然这并不能解决根本问题，但至少可以在运行时检测出问题。

### 新增的 Objective-C 注解 

<!--
The transformation of Objective-C completion-handler-based APIs to async Swift APIs could benefit from the introduction of additional annotations (in the form of attributes) to guide the process. For example:
-->

将基于 Objective-C completion-handler 的 API 转化为 async Swift API 时，会引入额外的标注（以注解的形式）来定制和优化这个过程。例如：

<!--
* `_Nullable_result`. Like `_Nullable`, indicates that a pointer can be null (or `nil`). `_Nullable_result` differs from `_Nullable` only for parameters to completion handler blocks. When the completion handler block's parameters are translated into the result type of an `async` method, the corresponding result will be optional.
* `__attribute__((swift_async(...)))`. An attribute to control the translation of an asynchronous completion-handler method to an `async` function. It has several operations within the parentheses:
  * `__attribute__((swift_async(none)))`. Disables the translation to `async`.  
  * `__attribute__((swift_async(not_swift_private, C)))`. Specifies that the method should be translated into an `async` method, using the parameter at index `C` as the completion handler parameter. The first (non-`self`) parameter has index 1.
  * `__attribute__((swift_async(swift_private, C)))`. Specifies that the method should be translated into an `async` method that is "Swift private" (only for use when wrapping), using the parameter at index `C` as the completion handler parameter. The first (non-`self`) parameter has index 1.
* `__attribute__((swift_attr("swift attribute")))`. A general-purpose Objective-C attribute to allow one to provide Swift attributes directly. In the context of concurrency, this allows Objective-C APIs to be annotated with a global actor (e.g., `@UIActor`).
* `__attribute__((swift_async_name("method(param1:param2:)")))`. Specifies the Swift name that should be used for the `async` translation of the API. The name should not include an argument label for the completion handler parameter.
* `__attribute__((swift_async_error(...)))`. An attribute to control how passing an `NSError *` into the completion handle maps into the method being `async throws`. It has several possible parameters:
  * `__attribute__((swift_async_error(none)))`: Do not import as `throws`. The `NSError *` parameter will be considered a normal parameter.
  * `__attribute__((swift_async_error(zero_argument(N)))`: Import as `throws`. When the Nth argument to the completion handler is passed the integral value zero (including `false`), the async method will throw the error. The Nth argument is removed from the result type of the translated `async` method. The first argument is `0`.
  * `__attribute__((swift_async_error(nonzero_argument(N)))`: Import as `throws`. When the Nth argument to the completion handler is passed a non-zero integral value (including `true`), the async method will throw the error. The Nth argument is removed from the result type of the translated `async` method.
-->

* `_Nullable_result`：与 `_Nullable` 一样，表示指针可以是 null 的（或 `nil`）。`_Nullable_result` 与 `_Nullable` 的不同之处只在于 completion-handler 参数。当 completion-handler 的参数被转换为 `async` 方法的结果类型时，相应的结果将会是 optional 的。
* `__attribute__((swift_async(...)))`：用于控制如何将异步 completion-handler 翻译成 `async` 函数的注解。它在括号内有这几种操作：
  * `__attribute__((swift_async(none)))`：禁用翻译为 `async`。 
  * `__attribute__((swift_async(not_swift_private, C)))`：指定该方法应该被翻译成 `async` 方法，使用索引 `C` 的参数作为 completion-handler 参数。第一个(非 `self`)参数的序号为 1。
  * `__attribute__((swift_async(swift_private, C)))`：将该方法翻译成 "Swift private" 的 `async` 方法(仅在封装时使用)，使用索引 `C` 的参数作为 completion-handler 参数。第一个(非 `self`)参数的序号为 1。
* `__attribute__((swift_attr("swift attribute")))`：一个通用 Objective-C 注解，允许大家直接提供 Swift 属性。在并发的上下文中，这允许 Objective-C API 被注解为一个全局 actor(例如，`@UIActor`)。
* `__attribute__((swift_async_name("method(param1:param2:)"))`：指定翻译后的 `async` 函数的 Swift 名称。该名称不应包括 completion-handler 参数的参数标签。
* `__attribute__((swift_async_error(...)))`。一个注解，用于控制如何将 `NSError *` 传递给 completion-handler 并且映射 `async throws` 的方法中。它有几个可用的参数：
  * `__attribute__((swift_async_error(none)))`：不要导入为 `throws`。`NSError *` 参数将被视为正常参数。
  * `__attribute__((swift_async_error(zero_argument(N)))`：导入为 `throws`。当 completion-handler 的第 n 个参数传递了一个为 0 的整数值（包括 `false`）时，async 方法将抛出错误。第 n 个参数会从翻译后的 `async` 方法的结果类型中删除。第一个参数的序号是 `1`。
  * `__attribute__((swift_async_error(nonzero_argument(N)))`：导入为 `throws`。当完成处理程序的第 n 个参数被传递了一个非 0 的整数值（包括 `true`）时，async 方法将抛出错误。第 n 个参数将从翻译后的 `async` 方法的结果类型中删除。

## 代码兼容性

<!--
Generally speaking, changes to the way in which Objective-C APIs are translated into Swift are source-breaking changes. To avoid breaking source compatibility, this proposal involves translating Objective-C asynchronous completion-handler methods as *both* their original completion-handler signatures and also with the new `async` signature. This allows existing Swift code bases to gradually adopt the `async` forms of API, rather than forcing (e.g.) an entire Swift module to adopt `async` all at once.
-->

一般来说，将 Objective-C API 翻译成 Swift 的规则修改是代码破坏性修改。为了避免破坏源码兼容性，这个提案会将 Objective-C 异步 completion-handler 方法翻译成 completion-handler 版本**以及**新的 `async` 版本。让现有的 Swift 代码库能够渐进地采用 `async` 形式的 API，而不是强迫（例如）整个 Swift 模块全部换成 `async`。

<!--
Importing the same Objective-C API in two different ways causes some issues:
-->

同时以两种不同的方式导入相同的 Objective-C API 会导致一些问题：

<!--
* Overloading of synchronous and asynchronous APIs. Objective-C frameworks may have evolved to include both synchronous and asynchronous versions of the same API, e.g.,
-->

* 同步和异步 API 的重载。Objective-C 框架可能已经同时包含同一个 API 的同步和异步版本，例如：

  ```objectivec
  - (NSString *)lookupName;
  - (void)lookupNameWithCompletionHandler:(void (^)(NSString *))completion;
  ```
  
  <!--
  which will be translated into three different Swift methods:
  -->
  
  会被翻译为三个不同的 Swift 方法：
  
  ```swift
  @objc func lookupName() -> String
  @objc func lookupName(withCompletionHandler: @escaping (String) -> Void)
  @objc func lookupName() async -> String
  ```

  <!--
  The first and third signatures are identical except for being synchronous and asynchronous, respectively. The async/await design doesn't allow such overloading to be written in the same Swift module, but it can happen when translating Objective-C APIs or when importing methods from different Swift modules. The async/await design accounts for such overloading by favoring synchronous functions in synchronous contexts and asynchronous functions in asynchronous contexts. This overloading should avoid breaking source compatibility.
  -->  
  
  第一个和第三个的函数签名，除了一个是同步一个是异步之外，其他都是一样的。async/await 的设计不允许在同一个 Swift 模块中编写这样的重载，但在翻译 Objective-C API 或从不同 Swift 模块中导入方法时，可能会发生这样的情况。async/await 会在同步上下文中有倾向性地选择同步函数，在异步上下文中有倾向性地选择异步函数，解决这种重载问题。这种重载应该避免破坏源码兼容性。

<!--
* Another issue is when an asynchronous completion-handler method is part of an Objective-C protocol. For example, the [`NSURLSessionDataDelegate` protocol](https://developer.apple.com/documentation/foundation/nsurlsessiondatadelegate?language=objc) includes this protocol requirement:
-->

* 另一个问题是当一个异步 completion-handler 方法是 Objective-C 协议的一部分。例如，[`NSURLSessionDataDelegate` 协议](https://developer.apple.com/documentation/foundation/nsurlsessiondatadelegate?language=objc)就包括了这种协议要求:

  ```objectivec
  @optional
  - (void)URLSession:(NSURLSession *)session
            dataTask:(NSURLSessionDataTask *)dataTask
  didReceiveResponse:(NSURLResponse *)response
   completionHandler:(void (^)(NSURLSessionResponseDisposition disposition))completionHandler;
  ```

  <!--
  Existing Swift code might implement this requirement in a conforming type using its completion-handler signature
  -->

  现有的 Swift 代码可能会在 conformance 里实现它的 completion-handler 版本：

  ```swift
  @objc
  func urlSession(
      _ session: URLSession,
      dataTask: URLSessionDataTask,
      didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) { ... }
  ```
  
  <!--
  while Swift code designed to take advantage of the concurrency model would implement this requirement in a conforming type using its `async` signature
  -->  
  
  而为使用并发模型而设计的 Swift 代码，可能会选择在 conformance 中实现它的 `async`  版本：

  ```swift
  @objc
  func urlSession(
      _ session: URLSession,
      dataTask: URLSessionDataTask,
      didReceive response: URLResponse
  ) async -> URLSession.ResponseDisposition { ... }
  ```
  
  <!--
  Implementing both requirements would produce an error (due to two Swift methods having the same selector), but under the normal Swift rules implementing only one of the requirements will also produce an error (because the other requirement is unsatisfied). Swift’s checking of protocol conformances will be extended to handle the case where multiple (imported) requirements have the same Objective-C selector: in that case, only one of them will be required to be implemented.
  -->  

  同时实现这两个版本会产生一个错误（这两个 Swift 方法有相同的 selector），但是根据正常的 Swift 规则，只实现其中一个要求也会产生错误（因为另一个需求不满足）。Swift 对协议 conformance 的检查将会被扩展，以处理多个（导入的）要求有相同的 Objective-C selector 的情况：在这种情况下，只需要实现其中的一个要求。

<!--
* Overriding methods that have been translated into both completion-handler and `async` versions have a similar problem to protocol requirements: a Swift subclass can either override the completion-handler version or the `async` version, but not both. Objective-C callers will always call to the subclass version of the method, but Swift callers to the "other" signature will not unless the subclass's method is marked with `@objc dynamic`. Swift can infer that the `async` overrides of such methods are `@objc dynamic` to avoid this problem (because such `async` methods are new code). However, inferring `@objc dynamic` on existing completion-handler overrides can change the behavior of programs and break subclasses of the subclasses, so at best the compiler can warn about this situation.
-->

* override 已被翻译成 completion-handler 和 `async` 版本的方法有一个类似于协议要求的问题：Swift 子类可以 override completion-handler 的版本或 `async` 的版本，但不能同时 override 这两个版本。Objective-C 的调用者总是会调用子类版本的方法，但 Swift 的调用者在调用另一个签名的函数时则不会，除非子类的方法被标记为 `@objc dynamic`。Swift可以将这类方法的 `async` override 隐式标记为 `@objc dynamic`，以避免这个问题（因为这类 `async` 方法是新代码）。但是，在现有的 completion-handler override 上将它推导为 `@objc dynamic` 会改变程序的行为，并破坏子类的子类，所以编译器最多只能对这种情况发出警告。

## 修订历史

* Post-review:
   * `await try` becomes `try await` based on result of SE-0296 review
   * Added inference of `@discardableResult` for `async` methods translated from completion-handler methods with an optional completion handler.
* Changes in the second pitch:
	* Removed mention of asynchronous handlers, which will be in a separate proposal.
	* Introduced the `swift_async_error` Clang attribute to separate out "throwing" behavior from the `swift_async` attribute.
	* Added support for "Swift private" to the `swift_async` attribute.
	* Tuned the naming heuristics based on feedback to add (e.g) `reply`, `replyTo`, `completionBlock`, and variants.
	* For the rare case where we match a parameter suffix, append the text prior to the suffix to the base name.
	* Replaced the `-generateCGImagesAsynchronouslyForTimes:completionHandler:` example with one from PassKit.
	* Added a "Future Directions" section about `NSProgress`.

* Original pitch ([document](https://github.com/DougGregor/swift-evolution/blob/9b9bdfd16eb5ced390913ea170007a46eabb08eb/proposals/NNNN-concurrency-objc.md) and [forum thread](https://forums.swift.org/t/concurrency-interoperability-with-objective-c/41616)).

## 改进方向

### NSProgress

<!--
Some Objective-C completion-handler methods return an [NSProgress](https://developer.apple.com/documentation/foundation/progress) to allow the caller to evaluate progress of the asynchronous operation. Such methods are *not* imported as `async` in this proposal, because the method does not return `void`. For example:
-->

一些 Objective-C completion-handler 方法会返回一个 [NSProgress](https://developer.apple.com/documentation/foundation/progress)，以便调用者评估异步操作的进度。在本提案中，这类方法**不回**被导入为 `async` 版本，因为该方法不返回 `void`。例如：

```swift
- (NSProgress *)doSomethingThatTakesALongTimeWithCompletionHandler:(void (^)(MyResult * _Nullable, NSError * _Nullable))completionHandler;
```

<!--
To support such methods would require some kind of integration between `NSProgress` and Swift's tasks. For example, when calling such a method, the `NSProgress` returned from such a call to be recorded in the task (say, in some kind of task-local storage). The other direction, where a Swift-defined method overrides a method, would need to extract an `NSProgress` from the task to return. Such a design is out of scope for this proposal, but could be introduced at some later point.
-->

要支持这种方法，就需要在 `NSProgress` 和 Swift 的任务之间进行某种整合。例如，当调用这样的方法时，从这样的调用中返回的 `NSProgress` 要记录在任务中（例如，在某种 task-local 的存储中）。还有另一个方向是，Swift 定义的方法 override 一个方法时，则需要从任务中提取一个 `NSProgress` 来返回。这样的设计不在本提案的范围内，但可以在以后的某个阶段引入。