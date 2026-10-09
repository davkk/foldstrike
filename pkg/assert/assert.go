package assert

import (
	"fmt"
	"reflect"
)

func Assert(truth bool, msg string, data ...any) {
	if !truth {
		panic(fmt.Sprintf(msg, data...))
	}
}

func Nil(v any, msg string) {
	Assert(isNil(v), "%s: expected nil, got %v", msg, v)
}

func NotNil(v any, msg string) {
	Assert(!isNil(v), "%s: expected non-nil", msg)
}

func NoError(err error, msg string, data ...any) {
	if err != nil {
		panic(fmt.Sprintf("%s: %v %v", msg, err, data))
	}
}

func Never(msg string, data ...any) {
	panic(fmt.Sprintf(msg, data...))
}

func isNil(v any) bool {
	if v == nil {
		return true
	}

	r := reflect.ValueOf(v)
	switch r.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface,
		reflect.Map, reflect.Pointer, reflect.Slice:
		return r.IsNil()
	default:
		return false
	}
}
