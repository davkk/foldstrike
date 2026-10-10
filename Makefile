.PHONY: build vet run

build:
	go build ...

vet:
	go vet ./...

run:
	go run ./cmd
